import { type Clip, type SaveResult } from "../types"
import { readClip, readClips, removeClipLocally, saveClipLocally } from "./localStorage"
import { requestSyncDelete, requestSyncUpsert } from "./syncClient"
import { getSyncSettings, saveSyncStatus } from "./syncState"
import { addTombstone, removeTombstone } from "./tombstones"

export { readClip, readClips } from "./localStorage"

/**
 * Retrieves a single clip by its ID from local storage.
 */
export async function getClip(id: string): Promise<Clip | null> {
    return readClip(id)
}

/**
 * Retrieves all clips associated with a specific videoId, sorted by update time descending.
 */
export async function getClipsForVideo(videoId: string): Promise<Clip[]> {
    const clips = await readClips()
    return clips.filter((c) => c.videoId === videoId)
}

/**
 * Upserts a clip locally first, then attempts cloud sync.
 * Background sync failures degrade gracefully to an error sync status without reverting the local save.
 */
export async function upsertClip(clip: Clip): Promise<SaveResult> {
    await saveClipLocally(clip)

    const settings = await getSyncSettings()
    if (!settings.syncEnabled) {
        await removeTombstone(clip.id, false)
        return { syncQuotaExceeded: false }
    }

    try {
        return await requestSyncUpsert(clip)
    } catch (err) {
        await removeTombstone(clip.id, false).catch((e) => {
            console.warn("[Carpe ClipService] Failed to clear local tombstone on fallback:", e)
        })
        const message = err instanceof Error ? err.message : String(err || "Sync error")
        await saveSyncStatus({ state: "error", message }).catch((e) => {
            console.warn("[Carpe ClipService] Failed to save error status on fallback:", e)
        })
        return { syncQuotaExceeded: false }
    }
}

/**
 * Deletes a clip locally first, then delegates tombstone recording and cloud removal.
 * Background sync failures fall back to a local tombstone and error status.
 */
export async function deleteClip(id: string): Promise<void> {
    await removeClipLocally(id)

    const settings = await getSyncSettings()
    if (!settings.syncEnabled) {
        await addTombstone(id, false)
        return
    }

    try {
        await requestSyncDelete(id)
    } catch (err) {
        await addTombstone(id, false).catch((e) => {
            console.warn("[Carpe ClipService] Failed to add local tombstone on fallback:", e)
        })
        const message = err instanceof Error ? err.message : String(err || "Sync error")
        await saveSyncStatus({ state: "error", message }).catch((e) => {
            console.warn("[Carpe ClipService] Failed to save error status on fallback:", e)
        })
    }
}
