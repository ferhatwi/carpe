import { type Clip } from "../types"

export function getClipTimestamp(clip: Clip): number {
    return clip.updatedAt ?? clip.createdAt ?? 0
}

export function sortClipsByUpdatedDesc(clips: Clip[]): Clip[] {
    return [...clips].sort((a, b) => getClipTimestamp(b) - getClipTimestamp(a))
}
