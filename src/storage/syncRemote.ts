import type { Clip, SyncConfig, SyncSettings } from "../types"
import { SYNC_CONFIG_KEY, SYNC_PREFIX, SYNC_TOMBSTONES_KEY } from "../types"
import { getClipTimestamp } from "../utils/clip"
import { isSyncAvailable } from "./storageHelpers"
import { classifySyncError, DEFAULT_MAX_SYNC_ITEMS, getSyncSettings } from "./syncState"
import { syncRemoveWithTracking, syncSetWithTracking } from "./syncTransport"
import { pruneTombstones } from "./tombstones"

export { isSyncAvailable }

export function extractSyncedClips(items: Record<string, unknown> | undefined): {
    clipsById: Map<string, Clip>
    keyEntries: { key: string; clip: Clip }[]
    rawTombstones: Record<string, number>
    remoteConfig: SyncConfig | null
} {
    const clipsById = new Map<string, Clip>()
    const keyEntries: { key: string; clip: Clip }[] = []
    let rawTombstones: Record<string, number> = {}
    let remoteConfig: SyncConfig | null = null

    for (const [key, value] of Object.entries(items || {})) {
        if (key === SYNC_TOMBSTONES_KEY && value && typeof value === "object") {
            rawTombstones = value as Record<string, number>
        } else if (key === SYNC_CONFIG_KEY && value && typeof value === "object") {
            const candidate = value as Partial<SyncConfig>
            if (typeof candidate.updatedAt === "number") {
                remoteConfig = {
                    archiveCutoff: typeof candidate.archiveCutoff === "number" ? candidate.archiveCutoff : undefined,
                    updatedAt: candidate.updatedAt
                }
            }
        } else if (key.startsWith(SYNC_PREFIX) && value && typeof value === "object") {
            const rawClip = value as Clip
            const id = typeof rawClip.id === "string" && rawClip.id ? rawClip.id : key.slice(SYNC_PREFIX.length)
            if (id) {
                const clip = rawClip.id === id ? rawClip : { ...rawClip, id }
                clipsById.set(id, clip)
                keyEntries.push({ key, clip })
            }
        }
    }

    return { clipsById, keyEntries, rawTombstones, remoteConfig }
}

export function hasUnsyncedClipsWithinCap(localClips: Clip[], syncedIds: Set<string>, settings: SyncSettings): boolean {
    const cap = settings.maxSyncItems || DEFAULT_MAX_SYNC_ITEMS
    const archiveCutoff = settings.archiveCutoff ?? 0
    return localClips
        .filter((clip) => getClipTimestamp(clip) > archiveCutoff)
        .slice(0, cap)
        .some((clip) => !syncedIds.has(clip.id))
}

export function hasPendingCloudDeletes(
    localTombstones: Record<string, number>,
    rawRemoteTombstones: Record<string, number>,
    syncedMap: Map<string, Clip>
): boolean {
    const prunedRemoteTombstones = pruneTombstones(rawRemoteTombstones)
    const hasUnpushedTombstones = Object.entries(localTombstones).some(
        ([id, deletedAt]) => !Object.hasOwn(prunedRemoteTombstones, id) || deletedAt > prunedRemoteTombstones[id]
    )
    if (hasUnpushedTombstones) {
        return true
    }
    return Array.from(syncedMap.entries()).some(
        ([id, clip]) => Object.hasOwn(localTombstones, id) && localTombstones[id] >= getClipTimestamp(clip)
    )
}

export async function readSyncedStateOrThrow(): Promise<{
    clipsById: Map<string, Clip>
    rawTombstones: Record<string, number>
}> {
    if (!isSyncAvailable()) {
        return { clipsById: new Map(), rawTombstones: {} }
    }
    const settings = await getSyncSettings()
    if (!settings.syncEnabled) {
        return { clipsById: new Map(), rawTombstones: {} }
    }
    const items = await chrome.storage.sync.get(null)
    const { clipsById, rawTombstones } = extractSyncedClips(items)
    return { clipsById, rawTombstones }
}

export async function readSyncedClipsOrThrow(): Promise<Map<string, Clip>> {
    const { clipsById } = await readSyncedStateOrThrow()
    return clipsById
}

/**
 * Retrieves the set of clip IDs currently stored in chrome.storage.sync for UI rendering.
 * Returns an empty set if sync is disabled, unavailable, or temporarily unreadable.
 */
export async function getSyncedClipIds(): Promise<Set<string>> {
    try {
        const syncedMap = await readSyncedClipsOrThrow()
        return new Set(syncedMap.keys())
    } catch {
        return new Set()
    }
}

export type SyncClipResult =
    | { success: true; quotaExceeded: boolean; error?: undefined }
    | { success: false; quotaExceeded: boolean; error: string }

export type CloudRemoveResult = { ok: true; error?: undefined } | { ok: false; error: unknown }

/**
 * Syncs a single clip to chrome.storage.sync.
 */
export async function syncClipToCloud(clip: Clip): Promise<SyncClipResult> {
    if (!isSyncAvailable()) {
        return {
            success: false,
            quotaExceeded: false,
            error: "Sync storage unavailable"
        }
    }

    const key = `${SYNC_PREFIX}${clip.id}`
    try {
        await syncSetWithTracking({ [key]: clip })
        return { success: true, quotaExceeded: false }
    } catch (err) {
        const { isQuotaExceeded, message } = classifySyncError(err)
        console.error("[Carpe Sync] Error writing to chrome.storage.sync:", message)
        return {
            success: false,
            quotaExceeded: isQuotaExceeded,
            error: message
        }
    }
}

/**
 * Removes multiple clips from chrome.storage.sync.
 */
export async function removeClipsFromCloud(ids: string[]): Promise<CloudRemoveResult> {
    if (!isSyncAvailable() || ids.length === 0) {
        return { ok: true }
    }
    const keys = ids.map((id) => `${SYNC_PREFIX}${id}`)
    try {
        await syncRemoveWithTracking(keys)
        return { ok: true }
    } catch (err) {
        console.warn("[Carpe Sync] Failed to remove clip(s) from sync:", err)
        return { ok: false, error: err }
    }
}

/**
 * Removes a single clip from chrome.storage.sync.
 */
export async function removeClipFromCloud(id: string): Promise<CloudRemoveResult> {
    return removeClipsFromCloud([id])
}
