import type { Clip } from "../types"
import type { ClipPushEntry } from "./syncMerge"
import { classifySyncError } from "./syncState"
import { syncSetWithTracking } from "./syncTransport"

export const SYNC_BATCH_SIZE = 20

export type PushResult = {
    pushedCount: number
    isQuotaExceeded?: boolean
} & (
    | {
          ok: true
          error?: undefined
      }
    | {
          ok: false
          error: string
      }
)

/**
 * Pushes local clip deltas to chrome.storage.sync in bounded batches,
 * automatically falling back to item-by-item upload if a batch exceeds the storage quota.
 */
export async function pushClipChunksWithFallback(
    clipsToPush: ClipPushEntry[],
    syncedIds: Set<string>
): Promise<PushResult> {
    let pushedCount = 0

    for (let i = 0; i < clipsToPush.length; i += SYNC_BATCH_SIZE) {
        const chunk = clipsToPush.slice(i, i + SYNC_BATCH_SIZE)
        const payload: Record<string, Clip> = {}
        for (const entry of chunk) {
            payload[entry.key] = entry.clip
        }

        try {
            await syncSetWithTracking(payload)
            for (const entry of chunk) {
                syncedIds.add(entry.id)
                pushedCount++
            }
        } catch (chunkErr) {
            const chunkErrorInfo = classifySyncError(chunkErr)
            if (!chunkErrorInfo.isQuotaExceeded) {
                console.error("[Carpe Sync] Error writing to chrome.storage.sync:", chunkErrorInfo.message)
                return {
                    ok: false,
                    error: chunkErrorInfo.message || "Failed to push clips",
                    isQuotaExceeded: false,
                    pushedCount
                }
            }

            // Chunk hit quota: push item-by-item until storage limit is reached
            for (const entry of chunk) {
                try {
                    await syncSetWithTracking({ [entry.key]: entry.clip })
                    syncedIds.add(entry.id)
                    pushedCount++
                } catch (itemErr) {
                    const { isQuotaExceeded, message } = classifySyncError(itemErr)
                    console.error("[Carpe Sync] Error writing to chrome.storage.sync:", message)
                    return {
                        ok: false,
                        error: message || "Failed to push clips",
                        isQuotaExceeded,
                        pushedCount
                    }
                }
            }
        }
    }

    return { ok: true, pushedCount }
}
