import { type Clip, type SaveResult } from "../types"
import { createTaskQueue } from "../utils/async"
import { executeArchiveOldSyncClips, type SyncArchiveResult } from "./syncArchive"
import { executeCloudDeleteClip, executeCloudImportSync, executeCloudUpsertClip } from "./syncMutations"
import { executePullAndMergeSyncClips } from "./syncPull"
import { type ImportMode } from "./syncTransport"

export * from "./syncState"
export * from "./syncRemote"
export * from "./syncMerge"
export * from "./syncPusher"
export * from "./syncArchive"
export * from "./syncMutations"
export * from "./syncPull"

const enqueueSyncWork = createTaskQueue()

/**
 * In-flight promise for coalescing concurrent pull-and-merge requests queued by external callers.
 */
let activeSyncPromise: Promise<{ pulled: number; pushed: number; totalCount: number }> | null = null

/**
 * Tracks actively executing pull-and-merge passes (including internal invocations
 * triggered by deletion backfills, imports, or archiving routines).
 */
let activeSyncPassCount = 0

/**
 * Returns true if a two-way sync pass is either queued or actively executing.
 */
export function isSyncPassRunning(): boolean {
    return activeSyncPassCount > 0 || activeSyncPromise !== null
}

async function runPullAndMergeSyncClips(forcePushIds?: Set<string>): Promise<{
    pulled: number
    pushed: number
    totalCount: number
}> {
    activeSyncPassCount++
    try {
        return await executePullAndMergeSyncClips(forcePushIds)
    } finally {
        activeSyncPassCount--
    }
}

/**
 * Reconciles clips between local storage and Chrome Sync (two-way sync).
 * Concurrent calls coalesce into a single background run.
 */
export function pullAndMergeSyncClips(): Promise<{
    pulled: number
    pushed: number
    totalCount: number
}> {
    if (!activeSyncPromise) {
        activeSyncPromise = enqueueSyncWork(() => runPullAndMergeSyncClips()).finally(() => {
            activeSyncPromise = null
        })
    }
    return activeSyncPromise
}

/**
 * Targeted cloud sync for a single clip save/update without triggering a full pull-and-merge pass.
 */
export function syncUpsertClip(clip: Clip): Promise<SaveResult> {
    return enqueueSyncWork(() => executeCloudUpsertClip(clip))
}

/**
 * Records a tombstone, removes the deleted clip from cloud sync, and reconciles sync status
 * (triggering a full pull-and-merge backfill if freeing cloud space under quota/error state).
 */
export function syncDeleteClip(id: string): Promise<void> {
    return enqueueSyncWork(() => executeCloudDeleteClip(id, () => runPullAndMergeSyncClips()))
}

/**
 * Propagates imported/replaced IDs to Chrome Sync and runs reconciliation.
 */
export function syncImportedClips(
    importedIds: string[],
    removedIds: string[],
    mode: ImportMode = "merge"
): Promise<{ pulled: number; pushed: number; totalCount: number }> {
    return enqueueSyncWork(() =>
        executeCloudImportSync(importedIds, removedIds, mode, (forceIds) => runPullAndMergeSyncClips(forceIds))
    )
}

/**
 * Archives oldest clips from Chrome Sync to free space while preserving all local clips
 * and advancing the archiveCutoff timestamp (resetting maxSyncItems to DEFAULT_MAX_SYNC_ITEMS).
 */
export function archiveOldSyncClips(keepCount: number): Promise<SyncArchiveResult> {
    return enqueueSyncWork(() => executeArchiveOldSyncClips(keepCount, () => runPullAndMergeSyncClips()))
}
