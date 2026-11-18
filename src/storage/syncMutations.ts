import { type Clip, type SaveResult, type SyncSettings, type SyncStatus } from "../types"
import { getClipTimestamp } from "../utils/clip"
import { readClips } from "./localStorage"
import {
    getSyncedClipIds,
    hasPendingCloudDeletes,
    hasUnsyncedClipsWithinCap,
    readSyncedClipsOrThrow,
    readSyncedStateOrThrow,
    removeClipFromCloud,
    removeClipsFromCloud,
    syncClipToCloud,
    type SyncClipResult
} from "./syncRemote"
import {
    classifySyncError,
    computeSteadySyncStatus,
    DEFAULT_MAX_SYNC_ITEMS,
    getSyncSettings,
    getSyncStatus,
    saveSyncStatus
} from "./syncState"
import { type ImportMode } from "./syncTransport"
import { addTombstones, getLocalTombstones, removeTombstones } from "./tombstones"
import { resetSyncSettingsForReplace } from "./syncArchive"

async function handleCloudUploadFailure(
    syncResult: Extract<SyncClipResult, { success: false }>,
    previousStatus: SyncStatus
): Promise<SaveResult> {
    const syncedAfterFail = await readSyncedClipsOrThrow().catch(() => null)
    const fallbackSyncedCount = syncedAfterFail
        ? syncedAfterFail.size
        : "syncedCount" in previousStatus
          ? (previousStatus.syncedCount ?? 0)
          : 0

    if (syncResult.quotaExceeded) {
        await saveSyncStatus({
            state: "quota_exceeded",
            syncedCount: fallbackSyncedCount,
            message: syncResult.error
        })
        return { syncQuotaExceeded: true }
    }

    await saveSyncStatus({
        state: "error",
        message: syncResult.error,
        syncedCount: fallbackSyncedCount
    })
    return { syncQuotaExceeded: false }
}

async function evictExcessSyncedClips(
    syncedMap: Map<string, Clip>,
    protectedId: string,
    cap: number
): Promise<unknown | null> {
    if (syncedMap.size <= cap) return null

    const evictIds = Array.from(syncedMap.values())
        .filter((c) => c.id !== protectedId)
        .sort((a, b) => getClipTimestamp(b) - getClipTimestamp(a))
        .slice(Math.max(0, cap - 1))
        .map((c) => c.id)

    if (evictIds.length === 0) return null

    const evictRes = await removeClipsFromCloud(evictIds)
    if (!evictRes.ok) {
        return evictRes.error
    }

    for (const id of evictIds) {
        syncedMap.delete(id)
    }
    return null
}

async function reconcileUpsertStatus(
    localClips: Clip[],
    syncedMap: Map<string, Clip>,
    rawRemoteTombstones: Record<string, number>,
    settings: SyncSettings,
    previousStatus: SyncStatus
): Promise<void> {
    const syncedIds = new Set(syncedMap.keys())
    const localTombstones = await getLocalTombstones()
    const hasPendingDeletes = hasPendingCloudDeletes(localTombstones, rawRemoteTombstones, syncedMap)
    const hasUnsyncedWithinCap = hasUnsyncedClipsWithinCap(localClips, syncedIds, settings)

    if (
        (previousStatus.state === "quota_exceeded" || previousStatus.state === "error") &&
        (hasUnsyncedWithinCap || hasPendingDeletes)
    ) {
        await saveSyncStatus({
            ...previousStatus,
            syncedCount: syncedIds.size
        })
        return
    }

    await saveSyncStatus(computeSteadySyncStatus(localClips, syncedIds))
}

/**
 * Uploads a single clip to the cloud, evicting excess items if exceeding capacity
 * and reconciling steady-state or error status.
 */
export async function executeCloudUpsertClip(clip: Clip): Promise<SaveResult> {
    const settings = await getSyncSettings()
    await removeTombstones([clip.id], settings.syncEnabled)

    if (!settings.syncEnabled) {
        return { syncQuotaExceeded: false }
    }

    const previousStatus = await getSyncStatus()
    const syncResult = await syncClipToCloud(clip)
    if (!syncResult.success) {
        return handleCloudUploadFailure(syncResult, previousStatus)
    }

    const syncedStateResult = await readSyncedStateOrThrow()
        .then((data) => ({ ok: true as const, data }))
        .catch((err) => ({ ok: false as const, error: err }))
    if (!syncedStateResult.ok) {
        const { message } = classifySyncError(syncedStateResult.error)
        await saveSyncStatus({ state: "error", message })
        return { syncQuotaExceeded: false }
    }

    const { clipsById: syncedMap, rawTombstones: rawRemoteTombstones } = syncedStateResult.data
    const cap = settings.maxSyncItems || DEFAULT_MAX_SYNC_ITEMS
    const evictError = await evictExcessSyncedClips(syncedMap, clip.id, cap)
    if (evictError) {
        const { isQuotaExceeded, message } = classifySyncError(evictError)
        await saveSyncStatus(
            isQuotaExceeded
                ? { state: "quota_exceeded", syncedCount: syncedMap.size, message }
                : { state: "error", message, syncedCount: syncedMap.size }
        )
        return { syncQuotaExceeded: false }
    }

    const localClips = await readClips()
    await reconcileUpsertStatus(localClips, syncedMap, rawRemoteTombstones, settings, previousStatus)
    return { syncQuotaExceeded: false }
}

async function reconcileDeleteStatus(
    wasInCloud: boolean,
    localClips: Clip[],
    syncedIds: Set<string>,
    followUpState: { clipsById: Map<string, Clip>; rawTombstones: Record<string, number> } | null,
    status: SyncStatus,
    localTombstones: Record<string, number>,
    settings: SyncSettings,
    triggerBackfill?: () => Promise<unknown>
): Promise<void> {
    const unsyncedWithinCap = hasUnsyncedClipsWithinCap(localClips, syncedIds, settings)
    const pendingDeletes = followUpState
        ? hasPendingCloudDeletes(localTombstones, followUpState.rawTombstones, followUpState.clipsById)
        : status.state === "quota_exceeded" || status.state === "error"

    if (!unsyncedWithinCap && !pendingDeletes) {
        await saveSyncStatus(computeSteadySyncStatus(localClips, syncedIds))
        return
    }

    if (wasInCloud && (status.state === "quota_exceeded" || status.state === "error") && triggerBackfill) {
        await triggerBackfill()
        return
    }

    if (status.state === "healthy" || status.state === "partial") {
        await saveSyncStatus(computeSteadySyncStatus(localClips, syncedIds))
        return
    }

    if (status.state === "quota_exceeded" || status.state === "error") {
        await saveSyncStatus({
            ...status,
            syncedCount: syncedIds.size
        })
    }
}

/**
 * Removes a clip from cloud sync, records a tombstone, and reconciles sync status
 * (triggering a full pull-and-merge backfill if freeing cloud space under quota/error state).
 */
export async function executeCloudDeleteClip(id: string, triggerBackfill?: () => Promise<unknown>): Promise<void> {
    const settings = await getSyncSettings()
    if (!settings.syncEnabled) {
        await addTombstones([id], false)
        return
    }

    const syncedBeforeResult = await readSyncedClipsOrThrow()
        .then((data) => ({ ok: true as const, data }))
        .catch((err) => ({ ok: false as const, error: err }))
    if (!syncedBeforeResult.ok) {
        await addTombstones([id], false)
        const { message } = classifySyncError(syncedBeforeResult.error)
        await saveSyncStatus({ state: "error", message })
        return
    }

    const syncedBefore = syncedBeforeResult.data
    const wasInCloud = syncedBefore.has(id)
    let deleteSyncError: unknown = null
    if (wasInCloud) {
        const removeRes = await removeClipFromCloud(id)
        if (!removeRes.ok) {
            deleteSyncError = removeRes.error
        } else {
            syncedBefore.delete(id)
        }
    }

    // Persist remote tombstone after freeing clip space so quota-full sync storage accepts it
    const tombstoneRes = await addTombstones([id], true)
    const syncFailure = deleteSyncError ?? (tombstoneRes.ok ? null : tombstoneRes.syncError)

    const [localClips, status, localTombstones] = await Promise.all([
        readClips(),
        getSyncStatus(),
        getLocalTombstones()
    ])
    let syncedIds = new Set(syncedBefore.keys())
    let followUpState: { clipsById: Map<string, Clip>; rawTombstones: Record<string, number> } | null = null
    try {
        followUpState = await readSyncedStateOrThrow()
        syncedIds = new Set(followUpState.clipsById.keys())
    } catch {
        // Keep adjusted syncedBefore set if follow-up read throws
    }

    if (syncFailure) {
        const { isQuotaExceeded, message } = classifySyncError(syncFailure)
        await saveSyncStatus(
            isQuotaExceeded
                ? { state: "quota_exceeded", syncedCount: syncedIds.size, message }
                : { state: "error", message, syncedCount: syncedIds.size }
        )
        return
    }

    await reconcileDeleteStatus(
        wasInCloud,
        localClips,
        syncedIds,
        followUpState,
        status,
        localTombstones,
        settings,
        triggerBackfill
    )
}

/**
 * Propagates imported/replaced IDs to Chrome Sync and runs reconciliation.
 */
export async function executeCloudImportSync(
    importedIds: string[],
    removedIds: string[],
    mode: ImportMode,
    triggerPullAndMerge?: (
        forcePushIds?: Set<string>
    ) => Promise<{ pulled: number; pushed: number; totalCount: number }>
): Promise<{ pulled: number; pushed: number; totalCount: number }> {
    const settings = await getSyncSettings()
    if (removedIds.length > 0) {
        await addTombstones(removedIds, false)
        if (settings.syncEnabled) {
            await removeClipsFromCloud(removedIds)
            await addTombstones(removedIds, true)
        }
    }
    if (mode === "replace") {
        await resetSyncSettingsForReplace(settings.syncEnabled)
    }
    const removeTombstonesRes = await removeTombstones(importedIds, settings.syncEnabled)

    if (!settings.syncEnabled) {
        const local = await readClips()
        return { pulled: 0, pushed: 0, totalCount: local.length }
    }
    if (!removeTombstonesRes.ok) {
        const { isQuotaExceeded, message } = classifySyncError(removeTombstonesRes.syncError)
        const [local, syncedIds] = await Promise.all([readClips(), getSyncedClipIds()])
        await saveSyncStatus(
            isQuotaExceeded
                ? { state: "quota_exceeded", syncedCount: syncedIds.size, message }
                : { state: "error", message, syncedCount: syncedIds.size }
        )
        return { pulled: 0, pushed: 0, totalCount: local.length }
    }
    if (triggerPullAndMerge) {
        return triggerPullAndMerge(new Set(importedIds))
    }
    const local = await readClips()
    return { pulled: 0, pushed: 0, totalCount: local.length }
}
