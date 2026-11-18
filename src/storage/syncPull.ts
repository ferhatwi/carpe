import {
    type Clip,
    SYNC_CONFIG_KEY,
    SYNC_PREFIX,
    SYNC_TOMBSTONES_KEY,
    type SyncConfig,
    type SyncSettings
} from "../types"
import { sortClipsByUpdatedDesc } from "../utils/clip"
import { readClips, removeClipsLocally, saveMergedClipsLocally } from "./localStorage"
import { extractSyncedClips, isSyncAvailable, removeClipsFromCloud } from "./syncRemote"
import {
    classifySyncError,
    computeSteadySyncStatus,
    DEFAULT_MAX_SYNC_ITEMS,
    getSyncSettings,
    mapsDiffer,
    saveSyncSettings,
    saveSyncStatus
} from "./syncState"
import { syncSetWithTracking } from "./syncTransport"
import { getLocalTombstones } from "./tombstones"
import {
    findClipsToPush,
    mergeLocalAndRemoteClips,
    resolveTombstonesAndStaleClips,
    selectBufferedClips
} from "./syncMerge"
import { pushClipChunksWithFallback } from "./syncPusher"

type PushMetadataResult =
    | { status: "success" }
    | { status: "quota-error"; message: unknown }
    | { status: "non-quota-error"; message: unknown }

async function pushMetadataPayload(payload: Record<string, unknown>, warnLabel: string): Promise<PushMetadataResult> {
    try {
        await syncSetWithTracking(payload)
        return { status: "success" }
    } catch (err) {
        console.warn(warnLabel, err)
        if (classifySyncError(err).isQuotaExceeded) {
            return { status: "quota-error", message: err }
        }
        return { status: "non-quota-error", message: err }
    }
}

interface ReconciledMetadata {
    settings: SyncSettings
    tombstones: Record<string, number>
    pendingConfigPush: SyncConfig | null
    pendingTombstonePush: boolean
    configQuotaError: unknown
    tombstoneQuotaError: unknown
    nonQuotaError: unknown
}

/**
 * Compares local and remote config versions, adopting newer remote settings or preparing a local config push.
 */
export async function reconcilePullConfig(
    settings: SyncSettings,
    remoteConfig: SyncConfig | null
): Promise<{ settings: SyncSettings; pendingConfigPush: SyncConfig | null }> {
    if (remoteConfig && remoteConfig.updatedAt > (settings.configUpdatedAt ?? 0)) {
        const updated = await saveSyncSettings({
            archiveCutoff: remoteConfig.archiveCutoff,
            maxSyncItems: DEFAULT_MAX_SYNC_ITEMS,
            configUpdatedAt: remoteConfig.updatedAt
        })
        return { settings: updated, pendingConfigPush: null }
    }
    if (settings.configUpdatedAt && settings.configUpdatedAt > (remoteConfig?.updatedAt ?? 0)) {
        return {
            settings,
            pendingConfigPush: {
                archiveCutoff: settings.archiveCutoff,
                updatedAt: settings.configUpdatedAt
            }
        }
    }
    return { settings, pendingConfigPush: null }
}

/**
 * Pushes reconciled tombstones to Chrome Sync if they differ from remote tombstones.
 */
export async function pushTombstonePayload(
    rawRemoteTombstones: Record<string, number>,
    tombstones: Record<string, number>
): Promise<{
    pendingTombstonePush: boolean
    tombstoneQuotaError: unknown
    nonQuotaError: unknown
}> {
    if (!mapsDiffer(rawRemoteTombstones, tombstones)) {
        return { pendingTombstonePush: false, tombstoneQuotaError: null, nonQuotaError: null }
    }

    const res = await pushMetadataPayload(
        { [SYNC_TOMBSTONES_KEY]: tombstones },
        "[Carpe Sync] Failed to reconcile tombstones in sync:"
    )
    if (res.status === "quota-error") {
        return { pendingTombstonePush: true, tombstoneQuotaError: res.message, nonQuotaError: null }
    }
    return {
        pendingTombstonePush: false,
        tombstoneQuotaError: null,
        nonQuotaError: res.status === "non-quota-error" ? res.message : null
    }
}

async function pushPendingPullConfig(pendingConfigPush: SyncConfig | null): Promise<{
    pendingConfigPush: SyncConfig | null
    configQuotaError: unknown
    nonQuotaError: unknown
}> {
    if (!pendingConfigPush) {
        return { pendingConfigPush: null, configQuotaError: null, nonQuotaError: null }
    }
    const res = await pushMetadataPayload(
        { [SYNC_CONFIG_KEY]: pendingConfigPush },
        "[Carpe Sync] Failed to push pending sync config:"
    )
    if (res.status === "quota-error") {
        return { pendingConfigPush, configQuotaError: res.message, nonQuotaError: null }
    }
    return {
        pendingConfigPush: null,
        configQuotaError: null,
        nonQuotaError: res.status === "non-quota-error" ? res.message : null
    }
}

async function reconcileCloudMetadata(
    remoteConfig: SyncConfig | null,
    rawRemoteTombstones: Record<string, number>,
    remoteClipsMap: Map<string, Clip>,
    initialSettings: SyncSettings
): Promise<ReconciledMetadata> {
    const { settings, pendingConfigPush: initialConfigPush } = await reconcilePullConfig(initialSettings, remoteConfig)

    const localTombstones = await getLocalTombstones()
    const { tombstones, staleRemoteIds } = resolveTombstonesAndStaleClips(
        remoteClipsMap,
        localTombstones,
        rawRemoteTombstones
    )
    if (mapsDiffer(localTombstones, tombstones)) {
        await chrome.storage.local.set({ [SYNC_TOMBSTONES_KEY]: tombstones })
    }

    const staleRemoveRes = await removeClipsFromCloud(staleRemoteIds)
    let nonQuotaError =
        !staleRemoveRes.ok && !classifySyncError(staleRemoveRes.error).isQuotaExceeded ? staleRemoveRes.error : null

    const configResult = await pushPendingPullConfig(initialConfigPush)
    nonQuotaError ??= configResult.nonQuotaError

    const tombstoneResult = await pushTombstonePayload(rawRemoteTombstones, tombstones)
    nonQuotaError ??= tombstoneResult.nonQuotaError

    return {
        settings,
        tombstones,
        pendingConfigPush: configResult.pendingConfigPush,
        pendingTombstonePush: tombstoneResult.pendingTombstonePush,
        configQuotaError: configResult.configQuotaError,
        tombstoneQuotaError: tombstoneResult.tombstoneQuotaError,
        nonQuotaError
    }
}

async function evictOverflowClipsAndRetryMetadata(
    latestLocalClips: Clip[],
    remoteClipsMap: Map<string, Clip>,
    meta: ReconciledMetadata,
    forcePushIds?: Set<string>
): Promise<{
    bufferedClips: Clip[]
    quotaStepError: unknown
    nonQuotaStepError: unknown
}> {
    const { bufferedClips, overflowRemoteIds } = selectBufferedClips(
        latestLocalClips,
        remoteClipsMap,
        meta.tombstones,
        meta.settings,
        forcePushIds
    )

    let configQuotaError = meta.configQuotaError
    let tombstoneQuotaError = meta.tombstoneQuotaError
    let nonQuotaError: unknown = null

    const overflowRemoveRes = await removeClipsFromCloud(overflowRemoteIds)
    if (overflowRemoveRes.ok) {
        for (const remoteId of overflowRemoteIds) {
            remoteClipsMap.delete(remoteId)
        }
        if (overflowRemoteIds.length > 0) {
            if (meta.pendingTombstonePush) {
                const res = await pushMetadataPayload(
                    { [SYNC_TOMBSTONES_KEY]: meta.tombstones },
                    "[Carpe Sync] Failed to reconcile tombstones after eviction:"
                )
                if (res.status === "quota-error") {
                    tombstoneQuotaError = res.message
                } else {
                    tombstoneQuotaError = null
                    if (res.status === "non-quota-error") {
                        nonQuotaError ??= res.message
                    }
                }
            }
            if (meta.pendingConfigPush) {
                const res = await pushMetadataPayload(
                    { [SYNC_CONFIG_KEY]: meta.pendingConfigPush },
                    "[Carpe Sync] Failed to push pending sync config after eviction:"
                )
                if (res.status === "quota-error") {
                    configQuotaError = res.message
                } else {
                    configQuotaError = null
                    if (res.status === "non-quota-error") {
                        nonQuotaError ??= res.message
                    }
                }
            }
        }
    } else if (!classifySyncError(overflowRemoveRes.error).isQuotaExceeded) {
        nonQuotaError = overflowRemoveRes.error
    }

    return {
        bufferedClips,
        quotaStepError: tombstoneQuotaError ?? configQuotaError,
        nonQuotaStepError: meta.nonQuotaError ?? nonQuotaError
    }
}

async function savePullAndMergeStatus(
    latestLocalClips: Clip[],
    syncedIds: Set<string>,
    nonQuotaStepError: unknown,
    quotaStepError: unknown
): Promise<void> {
    if (nonQuotaStepError) {
        const { message } = classifySyncError(nonQuotaStepError)
        await saveSyncStatus({
            state: "error",
            message,
            syncedCount: syncedIds.size
        })
        return
    }
    if (quotaStepError) {
        const { message } = classifySyncError(quotaStepError)
        await saveSyncStatus({
            state: "quota_exceeded",
            syncedCount: syncedIds.size,
            message
        })
        return
    }
    await saveSyncStatus(computeSteadySyncStatus(latestLocalClips, syncedIds))
}

/**
 * Executes a two-way synchronization cycle between local storage and Chrome Sync.
 */
export async function executePullAndMergeSyncClips(forcePushIds?: Set<string>): Promise<{
    pulled: number
    pushed: number
    totalCount: number
}> {
    if (!isSyncAvailable()) {
        const local = await readClips()
        return { pulled: 0, pushed: 0, totalCount: local.length }
    }

    let settings = await getSyncSettings()
    if (!settings.syncEnabled) {
        const local = await readClips()
        return { pulled: 0, pushed: 0, totalCount: local.length }
    }

    let items: Record<string, unknown>
    try {
        items = await chrome.storage.sync.get(null)
    } catch (err) {
        const { message } = classifySyncError(err)
        console.error("[Carpe Sync] Error reading chrome.storage.sync:", message)
        const local = await readClips()
        await saveSyncStatus({ state: "error", message })
        return { pulled: 0, pushed: 0, totalCount: local.length }
    }

    const { clipsById: remoteClipsMap, rawTombstones: rawRemoteTombstones, remoteConfig } = extractSyncedClips(items)

    const meta = await reconcileCloudMetadata(remoteConfig, rawRemoteTombstones, remoteClipsMap, settings)
    settings = meta.settings

    // Apply tombstones and merge remote clips into local storage
    const localClips = await readClips()
    const { idsToDeleteLocally, clipsToSaveLocally } = mergeLocalAndRemoteClips(
        localClips,
        remoteClipsMap,
        meta.tombstones
    )

    if (idsToDeleteLocally.length > 0) {
        await removeClipsLocally(idsToDeleteLocally)
    }
    const pulledCount =
        clipsToSaveLocally.length > 0
            ? await saveMergedClipsLocally(clipsToSaveLocally, new Set(localClips.map((c) => c.id)))
            : 0

    const latestLocalClips =
        idsToDeleteLocally.length > 0 || clipsToSaveLocally.length > 0
            ? sortClipsByUpdatedDesc(await readClips())
            : localClips

    const { bufferedClips, quotaStepError, nonQuotaStepError } = await evictOverflowClipsAndRetryMetadata(
        latestLocalClips,
        remoteClipsMap,
        meta,
        forcePushIds
    )

    const clipsToPush = findClipsToPush(
        bufferedClips,
        remoteClipsMap,
        SYNC_PREFIX,
        settings.archiveCutoff ?? 0,
        forcePushIds
    )

    if (clipsToPush.length === 0) {
        await savePullAndMergeStatus(
            latestLocalClips,
            new Set(remoteClipsMap.keys()),
            nonQuotaStepError,
            quotaStepError
        )
        return {
            pulled: pulledCount,
            pushed: 0,
            totalCount: latestLocalClips.length
        }
    }

    console.log(`[Carpe Sync] Pushing ${clipsToPush.length} local clip(s) to chrome.storage.sync...`)
    const syncedIds = new Set(remoteClipsMap.keys())
    const pushResult = await pushClipChunksWithFallback(clipsToPush, syncedIds)

    if (!pushResult.ok) {
        if (pushResult.isQuotaExceeded) {
            await saveSyncStatus({
                state: "quota_exceeded",
                syncedCount: syncedIds.size,
                message: pushResult.error
            })
        } else {
            await saveSyncStatus({
                state: "error",
                message: pushResult.error || "Failed to push clips",
                syncedCount: syncedIds.size
            })
        }
        return {
            pulled: pulledCount,
            pushed: pushResult.pushedCount,
            totalCount: latestLocalClips.length
        }
    }

    console.log(`[Carpe Sync] Successfully pushed ${pushResult.pushedCount} clip(s). Total in sync: ${syncedIds.size}`)
    await savePullAndMergeStatus(latestLocalClips, syncedIds, nonQuotaStepError, quotaStepError)
    return {
        pulled: pulledCount,
        pushed: pushResult.pushedCount,
        totalCount: latestLocalClips.length
    }
}
