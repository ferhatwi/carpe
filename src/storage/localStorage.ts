import { type Clip, LOCAL_CLIP_PREFIX, SYNC_PREFIX } from "../types"
import { createTaskQueue } from "../utils/async"
import { getClipTimestamp, sortClipsByUpdatedDesc } from "../utils/clip"

const enqueueLocalWrite = createTaskQueue()

function isClipRecord(value: unknown): value is Clip {
    if (!value || typeof value !== "object") return false
    const candidate = value as Record<string, unknown>
    return (
        typeof candidate.id === "string" &&
        typeof candidate.videoId === "string" &&
        typeof candidate.start === "number" &&
        typeof candidate.end === "number"
    )
}

export function hasLocalClipChange(changes: { [key: string]: chrome.storage.StorageChange }): boolean {
    return Object.keys(changes).some((key) => key.startsWith(LOCAL_CLIP_PREFIX))
}

export function hasSyncClipChange(changes: { [key: string]: chrome.storage.StorageChange }): boolean {
    return Object.keys(changes).some((key) => key.startsWith(SYNC_PREFIX))
}

/**
 * Reads all clips from Chrome local storage (stored per-clip under `clip_<id>` keys).
 * Local storage is the offline-first source of truth.
 */
export async function readClips(): Promise<Clip[]> {
    const items = await chrome.storage.local.get(null)
    const clips: Clip[] = []
    for (const [key, value] of Object.entries(items || {})) {
        if (key.startsWith(LOCAL_CLIP_PREFIX) && isClipRecord(value)) {
            clips.push(value)
        }
    }
    return sortClipsByUpdatedDesc(clips)
}

/**
 * Reads a single clip from Chrome local storage by its ID.
 */
export async function readClip(id: string): Promise<Clip | null> {
    const key = `${LOCAL_CLIP_PREFIX}${id}`
    const result = await chrome.storage.local.get(key)
    const item = result?.[key]
    return isClipRecord(item) ? item : null
}

/**
 * Replaces the local clip collection under `clip_<id>` keys, writing replacements before pruning removed keys.
 */
export async function writeClips(clips: Clip[]): Promise<void> {
    await enqueueLocalWrite(async () => {
        const items = await chrome.storage.local.get(null)
        const nextIds = new Set(clips.map((clip) => `${LOCAL_CLIP_PREFIX}${clip.id}`))
        const keysToRemove: string[] = []

        for (const key of Object.keys(items || {})) {
            if (key.startsWith(LOCAL_CLIP_PREFIX) && !nextIds.has(key)) {
                keysToRemove.push(key)
            }
        }

        if (clips.length > 0) {
            const payload: Record<string, Clip> = {}
            for (const clip of clips) {
                payload[`${LOCAL_CLIP_PREFIX}${clip.id}`] = clip
            }
            await chrome.storage.local.set(payload)
        }

        if (keysToRemove.length > 0) {
            await chrome.storage.local.remove(keysToRemove)
        }
    })
}

/**
 * Serializes and merges a single clip update into its `clip_<id>` key in chrome.storage.local.
 */
export async function saveClipLocally(clip: Clip): Promise<void> {
    await enqueueLocalWrite(async () => {
        const key = `${LOCAL_CLIP_PREFIX}${clip.id}`
        const result = await chrome.storage.local.get(key)
        const existing = result[key]
        const merged: Clip = isClipRecord(existing) ? { ...existing, ...clip } : clip
        await chrome.storage.local.set({ [key]: merged })
    })
}

/**
 * Serializes batch writes of full clip records into their `clip_<id>` keys in chrome.storage.local.
 */
export async function saveClipsLocally(clips: Clip[]): Promise<void> {
    if (clips.length === 0) return
    await enqueueLocalWrite(async () => {
        const payload: Record<string, Clip> = {}
        for (const clip of clips) {
            payload[`${LOCAL_CLIP_PREFIX}${clip.id}`] = clip
        }
        await chrome.storage.local.set(payload)
    })
}

/**
 * Merges remote clips into `clip_<id>` keys while skipping records that were deleted
 * or updated to a newer/equal timestamp in `chrome.storage.local` during the sync pass.
 */
export async function saveMergedClipsLocally(clips: Clip[], knownLocalIds: Set<string>): Promise<number> {
    if (clips.length === 0) return 0
    return enqueueLocalWrite(async () => {
        const keys = clips.map((clip) => `${LOCAL_CLIP_PREFIX}${clip.id}`)
        const currentItems: Record<string, unknown> = (await chrome.storage.local.get(keys)) ?? {}
        const payload: Record<string, Clip> = {}

        for (const clip of clips) {
            const key = `${LOCAL_CLIP_PREFIX}${clip.id}`
            const existingNow = currentItems[key]
            if (isClipRecord(existingNow)) {
                if (getClipTimestamp(existingNow) >= getClipTimestamp(clip)) {
                    continue
                }
            } else if (knownLocalIds.has(clip.id)) {
                // Clip was present locally when sync started and deleted concurrently mid-pass
                continue
            }
            payload[key] = clip
        }

        const count = Object.keys(payload).length
        if (count > 0) {
            await chrome.storage.local.set(payload)
        }
        return count
    })
}

/**
 * Removes multiple clips from local storage by their IDs.
 */
export async function removeClipsLocally(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await enqueueLocalWrite(async () => {
        await chrome.storage.local.remove(ids.map((id) => `${LOCAL_CLIP_PREFIX}${id}`))
    })
}

/**
 * Removes a single clip from local storage by its ID.
 */
export async function removeClipLocally(id: string): Promise<void> {
    await removeClipsLocally([id])
}
