import { PENDING_PLAYBACK_KEY, type PendingPlayback } from "../types"
import { createTaskQueue } from "../utils/async"
import { canSendRuntimeMessage, isForegroundContext } from "../utils/extension"
import { readStorageRecord } from "./storageHelpers"

const PENDING_PLAYBACK_MAX_AGE_MS = 60 * 1000
const DEFAULT_PENDING_PLAYBACK_SLOT = "default"
const enqueuePendingWrite = createTaskQueue()

function isPendingPlaybackEntry(value: unknown): value is PendingPlayback {
    if (!value || typeof value !== "object") return false
    const candidate = value as Record<string, unknown>
    return typeof candidate.clipId === "string" && typeof candidate.videoId === "string"
}

function prunePendingPlaybackMap(raw: unknown): Record<string, PendingPlayback> {
    const now = Date.now()
    const pruned: Record<string, PendingPlayback> = {}
    if (!raw || typeof raw !== "object") {
        return pruned
    }

    if (isPendingPlaybackEntry(raw)) {
        if (typeof raw.createdAt !== "number" || now - raw.createdAt <= PENDING_PLAYBACK_MAX_AGE_MS) {
            const slot = raw.tabId !== undefined ? String(raw.tabId) : DEFAULT_PENDING_PLAYBACK_SLOT
            pruned[slot] = raw
        }
        return pruned
    }

    for (const [slot, entry] of Object.entries(raw as Record<string, unknown>)) {
        if (!isPendingPlaybackEntry(entry)) continue
        if (typeof entry.createdAt === "number" && now - entry.createdAt > PENDING_PLAYBACK_MAX_AGE_MS) continue
        pruned[slot] = entry
    }
    return pruned
}

async function writePendingPlaybackMap(map: Record<string, PendingPlayback>): Promise<void> {
    if (Object.keys(map).length === 0) {
        await chrome.storage.local.remove(PENDING_PLAYBACK_KEY)
        return
    }
    await chrome.storage.local.set({ [PENDING_PLAYBACK_KEY]: map })
}

async function writePendingPlaybackSlot(playback: PendingPlayback): Promise<void> {
    await enqueuePendingWrite(async () => {
        const raw = await readStorageRecord(PENDING_PLAYBACK_KEY)
        const map = prunePendingPlaybackMap(raw)
        const slot = playback.tabId !== undefined ? String(playback.tabId) : DEFAULT_PENDING_PLAYBACK_SLOT
        map[slot] = {
            ...playback,
            createdAt: playback.createdAt ?? Date.now()
        }
        await writePendingPlaybackMap(map)
    })
}

/**
 * Stores a pending clip playback handoff scoped by target tab ID (or default fallback slot).
 * Routes through the service worker when available so all PENDING_PLAYBACK_KEY writes serialize in one context.
 */
export async function setPendingPlayback(playback: PendingPlayback): Promise<void> {
    if (canSendRuntimeMessage() && isForegroundContext()) {
        try {
            const response = (await chrome.runtime.sendMessage({
                action: "carpe:setPendingPlayback",
                playback
            })) as { ok?: boolean } | undefined
            if (response?.ok) {
                return
            }
        } catch {
            // Fall back to direct write if service worker messaging is unavailable
        }
    }
    await writePendingPlaybackSlot(playback)
}

/**
 * Retrieves and removes the pending clip playback handoff for a specific tab ID (when present)
 * and matching videoId. Avoids cross-tab interference when multiple YouTube tabs load concurrently.
 */
export async function consumePendingPlayback(videoId: string, tabId?: number): Promise<PendingPlayback | null> {
    return enqueuePendingWrite(async () => {
        const result = await chrome.storage.local.get(PENDING_PLAYBACK_KEY)
        const raw = result[PENDING_PLAYBACK_KEY]
        if (raw === undefined) {
            return null
        }

        const map = prunePendingPlaybackMap(raw)
        const slot = tabId !== undefined ? String(tabId) : DEFAULT_PENDING_PLAYBACK_SLOT
        const entry = Object.hasOwn(map, slot) ? map[slot] : undefined

        if (!entry || entry.videoId !== videoId) {
            const rawObject = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : null
            const needsCleanup =
                !rawObject ||
                "videoId" in rawObject ||
                Object.keys(map).length === 0 ||
                Object.keys(map).length !== Object.keys(rawObject).length
            if (needsCleanup) {
                await writePendingPlaybackMap(map)
            }
            return null
        }

        delete map[slot]
        await writePendingPlaybackMap(map)
        return entry
    })
}

/**
 * Drops any unconsumed pending playback entry for a closed tab.
 */
export async function clearPendingPlaybackForTab(tabId: number): Promise<void> {
    await enqueuePendingWrite(async () => {
        const raw = await readStorageRecord(PENDING_PLAYBACK_KEY)
        const map = prunePendingPlaybackMap(raw)
        const slot = String(tabId)
        if (slot in map) {
            delete map[slot]
            await writePendingPlaybackMap(map)
        }
    })
}

/**
 * Requests and consumes pending playback for the sender's browser tab via the service worker,
 * falling back to direct local storage access outside runtime-messaged environments.
 */
export async function requestTabPendingPlayback(videoId: string): Promise<PendingPlayback | null> {
    if (canSendRuntimeMessage() && isForegroundContext()) {
        try {
            const response = (await chrome.runtime.sendMessage({
                action: "carpe:consumePendingPlayback",
                videoId
            })) as { ok?: boolean; playback?: PendingPlayback | null } | undefined
            if (response?.ok) {
                return response.playback ?? null
            }
        } catch {
            // Fall back to direct lookup when service worker messaging is unavailable
        }
    }
    return consumePendingPlayback(videoId)
}
