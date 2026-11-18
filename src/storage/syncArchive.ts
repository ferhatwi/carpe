import { type Clip, SYNC_CONFIG_KEY, type SyncConfig, type SyncSettings } from "../types"
import { getClipTimestamp } from "../utils/clip"
import { readClips } from "./localStorage"
import { readStorageRecord } from "./storageHelpers"
import { extractSyncedClips, isSyncAvailable, readSyncedClipsOrThrow } from "./syncRemote"
import {
    classifySyncError,
    computeSteadySyncStatus,
    DEFAULT_MAX_SYNC_ITEMS,
    getSyncSettings,
    nextConfigTimestamp,
    saveSyncSettings,
    saveSyncStatus
} from "./syncState"
import { syncRemoveWithTracking, syncSetWithTracking } from "./syncTransport"

export const ARCHIVE_BATCH_SIZE = 50
export const ARCHIVE_VISIBLE_THRESHOLD = 200

/**
 * Calculates the number of older synced clips to prune based on the current synced count.
 */
export function calculateArchiveRemoveCount(syncedCount: number): number {
    if (syncedCount <= 1) {
        return 0
    }
    if (syncedCount >= 80) {
        return ARCHIVE_BATCH_SIZE
    }
    return Math.max(1, Math.floor(syncedCount * 0.5))
}

export type SyncArchiveResult =
    | { ok: true; removed: number; remaining: number; error?: undefined }
    | { ok: false; error: string; removed: 0; remaining: number }

/**
 * Clears archiveCutoff and resets maxSyncItems for a replace-mode backup import.
 */
export async function resetSyncSettingsForReplace(pushToCloud = false): Promise<void> {
    const current = await getSyncSettings()
    let remoteUpdatedAt = 0
    if (isSyncAvailable()) {
        const cfg = await readStorageRecord(SYNC_CONFIG_KEY, "sync").catch(() => ({}) as Record<string, unknown>)
        if (typeof cfg.updatedAt === "number" && Number.isFinite(cfg.updatedAt)) {
            remoteUpdatedAt = cfg.updatedAt
        }
    }
    const configUpdatedAt = nextConfigTimestamp(current.configUpdatedAt, remoteUpdatedAt)
    await saveSyncSettings({
        archiveCutoff: undefined,
        maxSyncItems: DEFAULT_MAX_SYNC_ITEMS,
        configUpdatedAt
    })
    if (pushToCloud && isSyncAvailable()) {
        const syncConfig: SyncConfig = { updatedAt: configUpdatedAt }
        await syncSetWithTracking({ [SYNC_CONFIG_KEY]: syncConfig }).catch((err) => {
            console.warn("[Carpe Sync] Failed to push reset config:", err)
        })
    }
}

/**
 * Partitions synced entries into remaining and removed sets, computing keys to remove
 * and the updated archive cutoff timestamp.
 */
export function partitionArchiveEntries(
    syncEntries: { key: string; clip: Clip }[],
    keepCount: number,
    currentArchiveCutoff = 0
): {
    remainingEntries: { key: string; clip: Clip }[]
    removedEntries: { key: string; clip: Clip }[]
    keysToRemove: string[]
    nextArchiveCutoff: number
} {
    syncEntries.sort((a, b) => getClipTimestamp(b.clip) - getClipTimestamp(a.clip))

    const targetKeep = Math.max(0, keepCount)
    const remainingEntries = syncEntries.slice(0, targetKeep)
    const removedEntries = syncEntries.slice(targetKeep)
    const keysToRemove = removedEntries.map((entry) => entry.key)

    const maxArchivedTimestamp = removedEntries.reduce(
        (maxTs, entry) => Math.max(maxTs, getClipTimestamp(entry.clip)),
        0
    )
    const nextArchiveCutoff = Math.max(currentArchiveCutoff, maxArchivedTimestamp)

    return { remainingEntries, removedEntries, keysToRemove, nextArchiveCutoff }
}

/**
 * Persists updated archive cutoff and maxSyncItems locally and to Chrome Sync.
 */
export async function persistArchiveConfig(
    settings: SyncSettings,
    remoteConfig: SyncConfig | null,
    nextArchiveCutoff: number
): Promise<void> {
    const configUpdatedAt = nextConfigTimestamp(settings.configUpdatedAt, remoteConfig?.updatedAt)
    await saveSyncSettings({
        archiveCutoff: nextArchiveCutoff,
        maxSyncItems: DEFAULT_MAX_SYNC_ITEMS,
        configUpdatedAt
    })

    const syncConfig: SyncConfig = { archiveCutoff: nextArchiveCutoff, updatedAt: configUpdatedAt }
    await syncSetWithTracking({ [SYNC_CONFIG_KEY]: syncConfig }).catch((err) => {
        console.warn("[Carpe Sync] Deferred SYNC_CONFIG_KEY update until next sync pass:", err)
    })
}

async function fetchSyncArchiveItems(): Promise<
    { ok: true; items: Record<string, unknown> } | { ok: false; error: string }
> {
    const itemsResult = await chrome.storage.sync
        .get(null)
        .then((items) => ({ ok: true as const, items }))
        .catch((err) => ({ ok: false as const, error: err }))
    if (!itemsResult.ok) {
        const { message } = classifySyncError(itemsResult.error)
        console.error("[Carpe Sync] Error reading sync clips for archiving:", message)
        await saveSyncStatus({ state: "error", message })
        return { ok: false, error: message }
    }
    return itemsResult
}

async function finalizeArchiveSuccess(
    keysToRemove: string[],
    remainingIds: Set<string>,
    nextArchiveCutoff: number,
    triggerBackfill?: () => Promise<unknown>
): Promise<SyncArchiveResult> {
    const localClips = await readClips()
    const hasPendingNewerClips = localClips.some(
        (clip) => !remainingIds.has(clip.id) && getClipTimestamp(clip) > nextArchiveCutoff
    )

    if (hasPendingNewerClips && triggerBackfill) {
        await triggerBackfill()
        const syncedAfterBackfill = await readSyncedClipsOrThrow().catch(() => null)
        return {
            ok: true,
            removed: keysToRemove.length,
            remaining: syncedAfterBackfill ? syncedAfterBackfill.size : remainingIds.size
        }
    }

    await saveSyncStatus(computeSteadySyncStatus(localClips, remainingIds))
    return { ok: true, removed: keysToRemove.length, remaining: remainingIds.size }
}

async function handleArchiveError(err: unknown, fallbackCount: number): Promise<SyncArchiveResult> {
    const { message } = classifySyncError(err)
    console.error("[Carpe Sync] Error archiving sync clips:", message)
    const actualRemaining = (await readSyncedClipsOrThrow().catch(() => null))?.size ?? fallbackCount
    await saveSyncStatus({
        state: "error",
        message,
        syncedCount: actualRemaining
    })
    return { ok: false, removed: 0, remaining: actualRemaining, error: message }
}

/**
 * Archives oldest clips from Chrome Sync to free space while preserving all local clips
 * and advancing the archiveCutoff timestamp (resetting maxSyncItems to DEFAULT_MAX_SYNC_ITEMS).
 */
export async function executeArchiveOldSyncClips(
    keepCount: number,
    triggerBackfill?: () => Promise<unknown>
): Promise<SyncArchiveResult> {
    if (!isSyncAvailable()) {
        return { ok: false, removed: 0, remaining: 0, error: "Sync storage unavailable" }
    }

    const settings = await getSyncSettings()
    if (!settings.syncEnabled) {
        return { ok: false, removed: 0, remaining: 0, error: "Sync is disabled" }
    }

    const itemsResult = await fetchSyncArchiveItems()
    if (!itemsResult.ok) {
        return { ok: false, removed: 0, remaining: 0, error: itemsResult.error }
    }

    const { keyEntries: syncEntries, remoteConfig } = extractSyncedClips(itemsResult.items)
    const { remainingEntries, keysToRemove, nextArchiveCutoff } = partitionArchiveEntries(
        syncEntries,
        keepCount,
        settings.archiveCutoff ?? 0
    )

    if (keysToRemove.length === 0) {
        const localClips = await readClips()
        await saveSyncStatus(computeSteadySyncStatus(localClips, new Set(syncEntries.map((entry) => entry.clip.id))))
        return { ok: true, removed: 0, remaining: syncEntries.length }
    }

    try {
        await syncRemoveWithTracking(keysToRemove)
        await persistArchiveConfig(settings, remoteConfig, nextArchiveCutoff)
        const remainingIds = new Set(remainingEntries.map((entry) => entry.clip.id))
        return await finalizeArchiveSuccess(keysToRemove, remainingIds, nextArchiveCutoff, triggerBackfill)
    } catch (err) {
        return handleArchiveError(err, syncEntries.length)
    }
}
