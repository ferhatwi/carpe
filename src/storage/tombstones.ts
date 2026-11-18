import { SYNC_TOMBSTONES_KEY } from "../types"
import { createTaskQueue } from "../utils/async"
import { isSyncAvailable, readStorageRecord } from "./storageHelpers"
import { syncSetWithTracking } from "./syncTransport"

const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000 // Keep tombstones for 90 days
const MAX_TOMBSTONES = 120 // Keep at most 120 most recent tombstones to stay safely under the 8KB sync item limit
const enqueueTombstoneWrite = createTaskQueue()

/**
 * Removes tombstones older than the max age threshold and caps to MAX_TOMBSTONES
 * to keep sync storage payload safely under the 8,192 byte QUOTA_BYTES_PER_ITEM limit.
 */
export function pruneTombstones(tombstones: Record<string, number>): Record<string, number> {
    const cutoff = Date.now() - TOMBSTONE_MAX_AGE_MS
    const validEntries = Object.entries(tombstones)
        .filter(([, deletedAt]) => typeof deletedAt === "number" && Number.isFinite(deletedAt) && deletedAt > cutoff)
        .sort(([, a], [, b]) => b - a)
        .slice(0, MAX_TOMBSTONES)

    return Object.fromEntries(validEntries)
}

/**
 * Merges two tombstone maps by keeping the latest deletion timestamp per clip ID.
 */
export function mergeTombstoneMaps(
    first: Record<string, number>,
    second: Record<string, number>
): Record<string, number> {
    const merged: Record<string, number> = { ...first }
    for (const [id, deletedAt] of Object.entries(second)) {
        if (typeof deletedAt === "number" && Number.isFinite(deletedAt)) {
            const prev = Object.hasOwn(merged, id) ? merged[id] : 0
            merged[id] = Math.max(prev, deletedAt)
        }
    }
    return pruneTombstones(merged)
}

/**
 * Reads active tombstones stored locally.
 */
export async function getLocalTombstones(): Promise<Record<string, number>> {
    const localMap = await readStorageRecord<number>(SYNC_TOMBSTONES_KEY, "local")
    return pruneTombstones(localMap)
}

/**
 * Retrieves pruned active tombstones merged from sync (when enabled) and local fallback.
 */
export async function getTombstones(readFromSync = true): Promise<Record<string, number>> {
    const localMap = await getLocalTombstones()
    if (!readFromSync || !isSyncAvailable()) return localMap

    try {
        const remoteMap = await readStorageRecord<number>(SYNC_TOMBSTONES_KEY, "sync")
        return mergeTombstoneMaps(localMap, remoteMap)
    } catch {
        // Fall back to local tombstones if sync read fails
    }

    return localMap
}

export type TombstoneSyncResult = { ok: true; syncError?: undefined } | { ok: false; syncError: unknown }

async function persistTombstones(
    tombstones: Record<string, number>,
    syncToCloud: boolean
): Promise<TombstoneSyncResult> {
    const pruned = pruneTombstones(tombstones)
    await chrome.storage.local.set({ [SYNC_TOMBSTONES_KEY]: pruned })

    if (syncToCloud && isSyncAvailable()) {
        try {
            await syncSetWithTracking({ [SYNC_TOMBSTONES_KEY]: pruned })
        } catch (err) {
            console.warn("[Carpe Sync] Failed to write tombstones to sync:", err)
            return { ok: false, syncError: err }
        }
    }
    return { ok: true }
}

/**
 * Adds multiple clip IDs to the tombstones map and propagates to storage.
 */
export async function addTombstones(ids: string[], syncToCloud = true): Promise<TombstoneSyncResult> {
    if (ids.length === 0) return { ok: true }

    let result: TombstoneSyncResult = { ok: true }
    await enqueueTombstoneWrite(async () => {
        const tombstones = await getTombstones(syncToCloud)
        const now = Date.now()
        for (const id of ids) {
            tombstones[id] = now
        }
        result = await persistTombstones(tombstones, syncToCloud)
    })
    return result
}

/**
 * Adds a clip ID to the tombstones map and propagates to storage.
 */
export async function addTombstone(id: string, syncToCloud = true): Promise<void> {
    await addTombstones([id], syncToCloud)
}

/**
 * Removes multiple clip IDs from tombstones (e.g. when clips are intentionally re-imported).
 */
export async function removeTombstones(ids: string[], syncToCloud = true): Promise<TombstoneSyncResult> {
    if (ids.length === 0) return { ok: true }

    let result: TombstoneSyncResult = { ok: true }
    await enqueueTombstoneWrite(async () => {
        const tombstones = await getTombstones(syncToCloud)
        let changed = false
        for (const id of ids) {
            if (Object.hasOwn(tombstones, id)) {
                delete tombstones[id]
                changed = true
            }
        }
        if (changed) {
            result = await persistTombstones(tombstones, syncToCloud)
        }
    })
    return result
}

/**
 * Removes an ID from tombstones (e.g. when a clip is intentionally re-created).
 */
export async function removeTombstone(id: string, syncToCloud = true): Promise<void> {
    await removeTombstones([id], syncToCloud)
}
