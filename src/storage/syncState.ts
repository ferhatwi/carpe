import type { Clip, SteadySyncStatus, SyncSettings, SyncStatus } from "../types"
import { SYNC_SETTINGS_KEY, SYNC_STATUS_KEY } from "../types"
import { readStorageRecord } from "./storageHelpers"

export const DEFAULT_MAX_SYNC_ITEMS = 250

export const DEFAULT_SETTINGS: SyncSettings = {
    syncEnabled: true,
    maxSyncItems: DEFAULT_MAX_SYNC_ITEMS
}

export function classifySyncError(err: unknown): { isQuotaExceeded: boolean; message: string } {
    const message = err instanceof Error ? err.message : String(err || "Sync error")
    const isRateLimit = /MAX_WRITE_OPERATIONS|writes per/i.test(message)
    const isQuotaExceeded = !isRateLimit && (/QUOTA_BYTES|MAX_ITEMS/i.test(message) || /quota/i.test(message))
    return { isQuotaExceeded, message }
}

export function mapsDiffer(a: Record<string, number>, b: Record<string, number>): boolean {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return true
    return aKeys.some((key) => a[key] !== b[key])
}

export function nextConfigTimestamp(localUpdatedAt?: number, remoteUpdatedAt?: number): number {
    return Math.max(Date.now(), (localUpdatedAt ?? 0) + 1, (remoteUpdatedAt ?? 0) + 1)
}

/**
 * Derives steady-state sync status ("healthy" vs "partial") from local clips and synced IDs.
 */
export function computeSteadySyncStatus(localClips: Clip[], syncedIds: Set<string>): SteadySyncStatus {
    const localOnlyCount = localClips.reduce((count, clip) => (syncedIds.has(clip.id) ? count : count + 1), 0)
    const syncedCount = syncedIds.size

    if (localOnlyCount === 0) {
        return {
            state: "healthy",
            lastSyncedAt: Date.now(),
            syncedCount
        }
    }

    return {
        state: "partial",
        lastSyncedAt: Date.now(),
        syncedCount,
        localOnlyCount
    }
}

export async function getSyncSettings(): Promise<SyncSettings> {
    const saved = await readStorageRecord<unknown>(SYNC_SETTINGS_KEY)
    return {
        ...DEFAULT_SETTINGS,
        ...(saved as Partial<SyncSettings>)
    }
}

export async function saveSyncSettings(settings: Partial<SyncSettings>): Promise<SyncSettings> {
    const current = await getSyncSettings()
    const updated = { ...current, ...settings }
    await chrome.storage.local.set({ [SYNC_SETTINGS_KEY]: updated })
    return updated
}

export async function getSyncStatus(): Promise<SyncStatus> {
    const settings = await getSyncSettings()
    if (!settings.syncEnabled) {
        return { state: "disabled" }
    }

    const raw = await readStorageRecord(SYNC_STATUS_KEY)

    if (raw.state === "quota_exceeded") {
        const errorMsg =
            typeof raw.message === "string" ? raw.message : typeof raw.error === "string" ? raw.error : undefined
        return {
            state: "quota_exceeded",
            syncedCount: Number(raw.syncedCount) || 0,
            message: errorMsg
        }
    }

    if (raw.state === "error") {
        return {
            state: "error",
            message: typeof raw.message === "string" ? raw.message : "Sync error",
            lastSyncedAt: typeof raw.lastSyncedAt === "number" ? raw.lastSyncedAt : undefined,
            syncedCount: Number(raw.syncedCount) || 0
        }
    }

    if (raw.state === "partial") {
        return {
            state: "partial",
            lastSyncedAt: typeof raw.lastSyncedAt === "number" ? raw.lastSyncedAt : 0,
            syncedCount: Number(raw.syncedCount) || 0,
            localOnlyCount: Math.max(1, Number(raw.localOnlyCount) || 0)
        }
    }

    return {
        state: "healthy",
        lastSyncedAt: typeof raw.lastSyncedAt === "number" ? raw.lastSyncedAt : 0,
        syncedCount: Number(raw.syncedCount) || 0
    }
}

export async function saveSyncStatus(status: SyncStatus): Promise<void> {
    await chrome.storage.local.set({ [SYNC_STATUS_KEY]: status })
}
