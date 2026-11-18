import type { Clip, SyncSettings } from "../types"
import { getClipTimestamp } from "../utils/clip"
import { DEFAULT_MAX_SYNC_ITEMS } from "./syncState"
import { mergeTombstoneMaps, pruneTombstones } from "./tombstones"

export interface TombstoneResolution {
    tombstones: Record<string, number>
    staleRemoteIds: string[]
}

export interface MergePlan {
    idsToDeleteLocally: string[]
    clipsToSaveLocally: Clip[]
}

export interface BufferSelection {
    bufferedClips: Clip[]
    bufferedIds: Set<string>
    overflowRemoteIds: string[]
}

export interface ClipPushEntry {
    key: string
    id: string
    clip: Clip
}

/**
 * Reconciles local and remote tombstone maps, and identifies stale remote clips that
 * have already been deleted according to the combined tombstones.
 */
export function resolveTombstonesAndStaleClips(
    remoteClipsMap: Map<string, Clip>,
    localTombstones: Record<string, number>,
    rawRemoteTombstones: Record<string, number>
): TombstoneResolution {
    const prunedRemote = pruneTombstones(rawRemoteTombstones)
    const tombstones = mergeTombstoneMaps(localTombstones, prunedRemote)
    const staleRemoteIds: string[] = []

    for (const [remoteId, remoteClip] of remoteClipsMap.entries()) {
        const deletedAt = tombstones[remoteId]
        const remoteTimestamp = getClipTimestamp(remoteClip)
        if (deletedAt && remoteTimestamp <= deletedAt) {
            staleRemoteIds.push(remoteId)
            remoteClipsMap.delete(remoteId)
        }
    }

    return { tombstones, staleRemoteIds }
}

/**
 * Evaluates two-way clip differences between local clips and cloud clips:
 * - Local clips whose deletion timestamp >= clip timestamp are marked for local deletion.
 * - Remote clips that are missing locally or have newer timestamps are staged for local save.
 */
export function mergeLocalAndRemoteClips(
    localClips: Clip[],
    remoteClipsMap: Map<string, Clip>,
    tombstones: Record<string, number>
): MergePlan {
    const localClipsMap = new Map(localClips.map((c) => [c.id, c]))
    const idsToDeleteLocally: string[] = []
    const clipsToSaveLocally: Clip[] = []

    for (const [clipId, clip] of localClipsMap.entries()) {
        const deletedAt = tombstones[clipId]
        const clipTimestamp = getClipTimestamp(clip)
        if (deletedAt && clipTimestamp <= deletedAt) {
            idsToDeleteLocally.push(clipId)
            localClipsMap.delete(clipId)
        }
    }

    for (const [remoteId, remoteClip] of remoteClipsMap.entries()) {
        const localClip = localClipsMap.get(remoteId)
        const remoteTimestamp = getClipTimestamp(remoteClip)
        const localTimestamp = localClip ? getClipTimestamp(localClip) : 0
        if (!localClip || remoteTimestamp > localTimestamp) {
            const mergedClip: Clip = {
                ...localClip,
                ...remoteClip,
                updatedAt: remoteTimestamp
            }
            localClipsMap.set(remoteId, mergedClip)
            clipsToSaveLocally.push(mergedClip)
        }
    }

    return { idsToDeleteLocally, clipsToSaveLocally }
}

/**
 * Selects up to `maxSyncItems` eligible clips to keep in cloud sync, skipping unedited
 * archived clips unless explicitly imported, and identifies overflow remote IDs for eviction.
 */
export function selectBufferedClips(
    latestLocalClips: Clip[],
    remoteClipsMap: Map<string, Clip>,
    tombstones: Record<string, number>,
    settings: SyncSettings,
    forcePushIds?: Set<string>
): BufferSelection {
    const bufferLimit = settings.maxSyncItems || DEFAULT_MAX_SYNC_ITEMS
    const archiveCutoff = settings.archiveCutoff ?? 0

    const bufferedClips = latestLocalClips
        .filter((clip) => {
            const deletedAt = tombstones[clip.id]
            const localTimestamp = getClipTimestamp(clip)
            if (deletedAt && localTimestamp <= deletedAt) return false
            return remoteClipsMap.has(clip.id) || Boolean(forcePushIds?.has(clip.id)) || localTimestamp > archiveCutoff
        })
        .slice(0, bufferLimit)

    const bufferedIds = new Set(bufferedClips.map((clip) => clip.id))
    const overflowRemoteIds: string[] = []
    for (const remoteId of remoteClipsMap.keys()) {
        if (!bufferedIds.has(remoteId)) {
            overflowRemoteIds.push(remoteId)
        }
    }

    return { bufferedClips, bufferedIds, overflowRemoteIds }
}

/**
 * Compares buffered local clips against remote cloud state to determine the exact delta entries
 * that must be uploaded.
 */
export function findClipsToPush(
    bufferedClips: Clip[],
    remoteClipsMap: Map<string, Clip>,
    syncPrefix: string,
    archiveCutoff: number,
    forcePushIds?: Set<string>
): ClipPushEntry[] {
    const clipsToPush: ClipPushEntry[] = []

    for (const clip of bufferedClips) {
        const localTimestamp = getClipTimestamp(clip)
        const remote = remoteClipsMap.get(clip.id)
        const remoteTimestamp = remote ? getClipTimestamp(remote) : 0
        const isExplicitlyEligible = localTimestamp > archiveCutoff || Boolean(forcePushIds?.has(clip.id))
        if ((!remote && isExplicitlyEligible) || (remote && localTimestamp > remoteTimestamp)) {
            clipsToPush.push({
                key: `${syncPrefix}${clip.id}`,
                id: clip.id,
                clip
            })
        }
    }

    return clipsToPush
}
