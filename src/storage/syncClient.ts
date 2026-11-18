import type { Clip, SaveResult } from "../types"
import { canSendRuntimeMessage } from "../utils/extension"
import {
    archiveOldSyncClips,
    pullAndMergeSyncClips,
    syncDeleteClip,
    syncImportedClips,
    syncUpsertClip
} from "./syncEngine"
import { type ImportMode, sendSyncRequest } from "./syncTransport"

export interface SyncReconcileResult {
    pulled: number
    pushed: number
    totalCount: number
}

import type { SyncArchiveResult } from "./syncArchive"
export type { SyncArchiveResult }

export type SyncImportResult = SyncReconcileResult

/**
 * Requests the background service worker to sync a single clip save/update to the cloud.
 * Falls back to direct execution in non-extension/unit-test environments where messaging is absent.
 */
export function requestSyncUpsert(clip: Clip): Promise<SaveResult> {
    if (canSendRuntimeMessage()) {
        return sendSyncRequest<SaveResult>({ action: "carpe:sync", op: "upsert", clip })
    }
    return syncUpsertClip(clip)
}

/**
 * Requests the background service worker to remove a deleted clip from the cloud.
 */
export function requestSyncDelete(id: string): Promise<void> {
    if (canSendRuntimeMessage()) {
        return sendSyncRequest<void>({ action: "carpe:sync", op: "delete", id })
    }
    return syncDeleteClip(id)
}

/**
 * Requests the background service worker to run a full two-way sync reconciliation (pull, merge, and push).
 */
export function requestSyncReconcile(): Promise<SyncReconcileResult> {
    if (canSendRuntimeMessage()) {
        return sendSyncRequest<SyncReconcileResult>({ action: "carpe:sync", op: "reconcile" })
    }
    return pullAndMergeSyncClips()
}

/**
 * Requests the background service worker to archive clips older than the top keepCount.
 */
export function requestSyncArchive(keepCount: number): Promise<SyncArchiveResult> {
    if (canSendRuntimeMessage()) {
        return sendSyncRequest<SyncArchiveResult>({ action: "carpe:sync", op: "archive", keepCount })
    }
    return archiveOldSyncClips(keepCount)
}

/**
 * Requests the background service worker to reconcile imported and removed clips with cloud sync.
 */
export function requestSyncImport(
    importedIds: string[],
    removedIds: string[],
    mode: ImportMode = "merge"
): Promise<SyncImportResult> {
    if (canSendRuntimeMessage()) {
        return sendSyncRequest<SyncImportResult>({
            action: "carpe:sync",
            op: "import",
            importedIds,
            removedIds,
            mode
        })
    }
    return syncImportedClips(importedIds, removedIds, mode)
}
