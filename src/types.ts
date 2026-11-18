export const LOCAL_CLIP_PREFIX = "clip_"
export const SCHEMA_VERSION_KEY = "ytClipSchemaVersion"
export const CURRENT_SCHEMA_VERSION = 1
export const SYNC_PREFIX = "sync_clip_"
export const SYNC_CONFIG_KEY = "sync_config"
export const SYNC_STATUS_KEY = "ytClipSyncStatus"
export const SYNC_SETTINGS_KEY = "ytClipSyncSettings"
export const SYNC_TOMBSTONES_KEY = "ytClipTombstones"
export const SYNC_RETRY_STATE_KEY = "ytClipSyncRetryAttempts"
export const PENDING_PLAYBACK_KEY = "ytClipperPendingPlayback"

export interface SyncConfig {
    archiveCutoff?: number
    updatedAt: number
}

export interface PendingPlayback {
    clipId: string
    videoId: string
    tabId?: number
    createdAt?: number
}

export type SteadySyncStatus =
    | { state: "healthy"; lastSyncedAt: number; syncedCount: number }
    | { state: "partial"; lastSyncedAt: number; syncedCount: number; localOnlyCount: number }

export type SyncStatus =
    | SteadySyncStatus
    | { state: "disabled" }
    | { state: "quota_exceeded"; syncedCount: number; message?: string }
    | {
          state: "error"
          message: string
          lastSyncedAt?: number
          syncedCount?: number
      }

export interface SyncSettings {
    syncEnabled: boolean
    maxSyncItems: number
    archiveCutoff?: number
    configUpdatedAt?: number
}

export interface SaveResult {
    syncQuotaExceeded: boolean
}

export interface Clip {
    id: string
    videoId: string
    title: string
    videoTitle: string
    start: number
    end: number
    createdAt: number
    updatedAt: number
}

export interface ActiveClip {
    id: string
    videoId: string
    start: number
    end: number
}

export interface WatchContext {
    videoId: string
    video: HTMLVideoElement
    player: HTMLElement
}

export interface SelectionRange {
    start: number
    end: number
}

export type PlaybackState = "idle" | "waiting-for-ready" | "seeking" | "playing"
