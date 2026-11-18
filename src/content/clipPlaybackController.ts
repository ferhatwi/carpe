import type { ActiveClip, Clip, PlaybackState } from "../types"
import { isAdShowing } from "../utils/youtube"
import { PlayerReadinessWatcher } from "./playerReadinessWatcher"

const SEEK_LANDING_TOLERANCE = 0.25
const MAX_SEEK_CORRECTIONS = 3

export interface PlaybackControllerCallbacks {
    onActiveClipChange?: (activeClip: ActiveClip | null) => void
    onProgressUpdate?: () => void
    isBoundarySuspended?: () => boolean
    getSuspendedBoundaryEnd?: () => number | null
}

/**
 * Manages video boundary enforcement, seek landing, and playback of active clips
 * via a media-event state machine.
 */
export class ClipPlaybackController {
    private readonly video: HTMLVideoElement
    private readonly player: HTMLElement
    private readonly readinessWatcher: PlayerReadinessWatcher
    private activeClip: ActiveClip | null = null
    private state: PlaybackState = "idle"
    private seekCorrectionCount = 0
    private lastObservedTime: number | null = null
    private crossedEditEnd: number | null = null
    private ignoreNextBoundarySeekClear = false
    private hasCompletedPlayback = false
    private isDisposed = false
    private callbacks: PlaybackControllerCallbacks
    private frameCallbackId: number | null = null

    constructor(video: HTMLVideoElement, player: HTMLElement, callbacks: PlaybackControllerCallbacks = {}) {
        this.video = video
        this.player = player
        this.callbacks = callbacks
        this.readinessWatcher = new PlayerReadinessWatcher(this.player, this.video, () => {
            if (this.state === "waiting-for-ready") {
                this.transitionToSeeking()
            }
        })

        this.bindEvents()
    }

    get clip(): ActiveClip | null {
        return this.activeClip
    }

    get isParkedAtEnd(): boolean {
        return Boolean(this.activeClip && this.hasCompletedPlayback)
    }

    playClip(clip: Clip | ActiveClip): void {
        const start = Number(clip.start)
        const end = Number(clip.end)
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
            this.clearActiveClip()
            return
        }

        this.seekCorrectionCount = 0
        this.hasCompletedPlayback = false
        this.activeClip = {
            id: clip.id,
            videoId: clip.videoId,
            start,
            end
        }

        this.callbacks.onProgressUpdate?.()
        this.callbacks.onActiveClipChange?.(this.activeClip)

        this.transitionToWaitingForReady()
    }

    private transitionToWaitingForReady(): void {
        if (this.isDisposed || !this.activeClip) return

        this.state = "waiting-for-ready"
        this.readinessWatcher.start()
    }

    private enterPlayingState(): void {
        this.seekCorrectionCount = 0
        this.state = "playing"
        this.lastObservedTime = this.video.currentTime
        this.crossedEditEnd = null
        this.ignoreNextBoundarySeekClear = false
        this.callbacks.onProgressUpdate?.()
        this.startFrameLoop()
    }

    private transitionToSeeking(): void {
        if (this.isDisposed || !this.activeClip) return

        this.readinessWatcher.stop()
        this.lastObservedTime = null
        this.crossedEditEnd = null
        this.ignoreNextBoundarySeekClear = false

        if (this.callbacks.isBoundarySuspended?.()) {
            this.enterPlayingState()
            return
        }

        if (
            Number.isFinite(this.video.duration) &&
            this.video.duration > 0 &&
            this.activeClip.start >= this.video.duration
        ) {
            this.clearActiveClip()
            return
        }

        // Skip re-seeking when already inside clip start window (bounded below clip.end for short clips)
        const isAlreadyAtStart =
            this.video.currentTime >= this.activeClip.start - SEEK_LANDING_TOLERANCE &&
            this.video.currentTime <= this.activeClip.start + 0.5 &&
            this.video.currentTime < this.activeClip.end

        if (isAlreadyAtStart) {
            this.enterPlayingState()
            this.video.play()?.catch(() => {})
            return
        }

        this.state = "seeking"
        this.video.currentTime = this.activeClip.start

        this.video.play()?.catch(() => {})
    }

    private finishPlaybackAtEnd(clipEnd: number): void {
        this.hasCompletedPlayback = true
        this.video.pause()
        const ended = this.video.ended
        if (!ended && Math.abs(this.video.currentTime - clipEnd) > 0.03) {
            this.video.currentTime = clipEnd
        }
        this.callbacks.onProgressUpdate?.()
    }

    private handleSuspendedBoundaryTick(): boolean {
        if (this.video.seeking || !this.activeClip) {
            return false
        }

        const currentTime = this.video.currentTime
        const prevTime = this.lastObservedTime
        this.lastObservedTime = currentTime

        const boundaryEnd = this.callbacks.getSuspendedBoundaryEnd?.()
        if (boundaryEnd === null || boundaryEnd === undefined || !Number.isFinite(boundaryEnd)) {
            return false
        }

        if (this.crossedEditEnd !== null && Math.abs(boundaryEnd - this.crossedEditEnd) < 0.001) {
            if (currentTime < boundaryEnd - 0.01) {
                this.crossedEditEnd = null
            } else {
                return false
            }
        } else {
            this.crossedEditEnd = null
        }

        const crossedThroughEnd = prevTime !== null && prevTime < boundaryEnd && currentTime >= boundaryEnd
        if (crossedThroughEnd && !this.video.paused) {
            this.crossedEditEnd = boundaryEnd
            this.video.pause()
            if (!this.video.ended && Math.abs(currentTime - boundaryEnd) > 0.03) {
                this.ignoreNextBoundarySeekClear = true
                this.video.currentTime = boundaryEnd
            }
            this.lastObservedTime = boundaryEnd
            this.callbacks.onProgressUpdate?.()
            return true
        }

        return false
    }

    private checkPlaybackBoundary(): boolean {
        if (!this.activeClip) return false
        if (this.callbacks.isBoundarySuspended?.()) {
            return this.handleSuspendedBoundaryTick()
        }
        if (this.video.seeking) {
            return false
        }
        if (this.hasCompletedPlayback) {
            if (!this.video.paused) {
                this.clearActiveClip()
            }
            return false
        }
        if (this.video.currentTime >= this.activeClip.end) {
            this.finishPlaybackAtEnd(this.activeClip.end)
            return true
        }
        return false
    }

    private startFrameLoop(): void {
        this.stopFrameLoop()
        if (
            typeof this.video.requestVideoFrameCallback !== "function" ||
            this.state !== "playing" ||
            !this.activeClip
        ) {
            return
        }

        const onFrame = () => {
            this.frameCallbackId = null
            if (this.isDisposed || this.state !== "playing" || !this.activeClip) {
                return
            }

            if (this.checkPlaybackBoundary()) {
                return
            }

            this.callbacks.onProgressUpdate?.()
            if (typeof this.video.requestVideoFrameCallback === "function") {
                this.frameCallbackId = this.video.requestVideoFrameCallback(onFrame)
            }
        }

        this.frameCallbackId = this.video.requestVideoFrameCallback(onFrame)
    }

    private stopFrameLoop(): void {
        if (this.frameCallbackId !== null && typeof this.video.cancelVideoFrameCallback === "function") {
            this.video.cancelVideoFrameCallback(this.frameCallbackId)
            this.frameCallbackId = null
        }
    }

    clearActiveClip(): void {
        if (!this.activeClip && this.state === "idle") return

        this.stopFrameLoop()
        this.readinessWatcher.stop()
        this.seekCorrectionCount = 0
        this.lastObservedTime = null
        this.crossedEditEnd = null
        this.ignoreNextBoundarySeekClear = false
        this.hasCompletedPlayback = false
        this.state = "idle"
        this.activeClip = null
        this.callbacks.onProgressUpdate?.()
        this.callbacks.onActiveClipChange?.(null)
    }

    updateActiveClipRange(start: number, end: number): void {
        if (this.isDisposed || !this.activeClip) return
        const nextStart = Number(start)
        const nextEnd = Number(end)
        if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextStart < 0 || nextEnd <= nextStart) {
            this.clearActiveClip()
            return
        }
        if (this.video.currentTime < nextEnd - 0.03) {
            this.hasCompletedPlayback = false
        }
        this.activeClip = {
            ...this.activeClip,
            start: nextStart,
            end: nextEnd
        }
        this.callbacks.onProgressUpdate?.()
    }

    reconcileActiveClip(): void {
        if (this.isDisposed || !this.activeClip || this.callbacks.isBoundarySuspended?.()) return
        if (isAdShowing(this.player)) {
            this.transitionToWaitingForReady()
            return
        }
        if (this.state === "waiting-for-ready" || this.state === "seeking") {
            return
        }

        this.crossedEditEnd = null
        const currentTime = this.video.currentTime
        this.lastObservedTime = currentTime
        const outsideClip =
            this.video.ended ||
            currentTime < this.activeClip.start - SEEK_LANDING_TOLERANCE ||
            (this.video.paused ? currentTime > this.activeClip.end + 0.03 : currentTime >= this.activeClip.end)

        if (outsideClip) {
            this.clearActiveClip()
            return
        }

        if (this.video.paused && currentTime >= this.activeClip.end - 0.03) {
            this.hasCompletedPlayback = true
        } else {
            this.hasCompletedPlayback = false
        }

        this.callbacks.onProgressUpdate?.()
        if (!this.video.paused) {
            this.startFrameLoop()
        }
    }

    private bindEvents(): void {
        this.video.addEventListener("seeking", this.onSeeking)
        this.video.addEventListener("seeked", this.onSeeked)
        this.video.addEventListener("timeupdate", this.onTimeUpdate)
        this.video.addEventListener("play", this.onPlay)
        this.video.addEventListener("pause", this.onPause)
        this.video.addEventListener("ended", this.onEnded)
    }

    private unbindEvents(): void {
        this.video.removeEventListener("seeking", this.onSeeking)
        this.video.removeEventListener("seeked", this.onSeeked)
        this.video.removeEventListener("timeupdate", this.onTimeUpdate)
        this.video.removeEventListener("play", this.onPlay)
        this.video.removeEventListener("pause", this.onPause)
        this.video.removeEventListener("ended", this.onEnded)
    }

    private onSeeking = (): void => {
        if (this.isDisposed) return
        // Do not compare pre-seek timestamps against post-seek positions while a scrub/jump is in flight
        this.lastObservedTime = null
    }

    private onPlay = (): void => {
        if (this.activeClip && this.hasCompletedPlayback && !this.callbacks.isBoundarySuspended?.()) {
            this.clearActiveClip()
            return
        }
        if (this.state === "playing") {
            this.lastObservedTime = this.video.currentTime
            this.startFrameLoop()
        }
    }

    private onPause = (): void => {
        this.stopFrameLoop()
    }

    private onEnded = (): void => {
        if (this.isDisposed || this.state !== "playing" || !this.activeClip) {
            return
        }
        if (this.callbacks.isBoundarySuspended?.()) {
            const boundaryEnd = this.callbacks.getSuspendedBoundaryEnd?.()
            if (boundaryEnd !== null && boundaryEnd !== undefined && Number.isFinite(boundaryEnd)) {
                this.crossedEditEnd = boundaryEnd
            }
            this.lastObservedTime = this.video.currentTime
            this.callbacks.onProgressUpdate?.()
            return
        }
        this.finishPlaybackAtEnd(this.activeClip.end)
    }

    private onSeeked = (): void => {
        if (this.isDisposed) return

        if (isAdShowing(this.player)) {
            if (this.activeClip) {
                this.transitionToWaitingForReady()
            }
            return
        }

        if (this.state === "seeking" && this.activeClip) {
            if (this.callbacks.isBoundarySuspended?.()) {
                this.enterPlayingState()
                return
            }

            const landedInClip =
                this.video.currentTime >= this.activeClip.start - SEEK_LANDING_TOLERANCE &&
                this.video.currentTime <= this.activeClip.end

            if (landedInClip) {
                this.enterPlayingState()
                return
            }

            // YouTube startup scripts may reset currentTime once after initial seek; cap retries to avoid loops.
            const unreachableStart =
                Number.isFinite(this.video.duration) &&
                this.video.duration > 0 &&
                this.activeClip.start >= this.video.duration

            if (!unreachableStart && this.seekCorrectionCount < MAX_SEEK_CORRECTIONS) {
                this.seekCorrectionCount++
                this.video.currentTime = this.activeClip.start
            } else {
                this.clearActiveClip()
            }
            return
        }

        if (this.state === "playing" && this.activeClip) {
            if (this.callbacks.isBoundarySuspended?.()) {
                const fromBoundarySnap = this.ignoreNextBoundarySeekClear
                this.ignoreNextBoundarySeekClear = false
                this.lastObservedTime = this.video.currentTime
                if (
                    !fromBoundarySnap &&
                    this.crossedEditEnd !== null &&
                    this.video.currentTime < this.crossedEditEnd - 0.01
                ) {
                    this.crossedEditEnd = null
                }
                this.callbacks.onProgressUpdate?.()
                return
            }

            const outsideClip =
                this.video.currentTime < this.activeClip.start - SEEK_LANDING_TOLERANCE ||
                this.video.currentTime > this.activeClip.end + 0.03

            if (outsideClip) {
                this.clearActiveClip()
                return
            }

            if (this.video.currentTime < this.activeClip.end - 0.03) {
                this.hasCompletedPlayback = false
            } else if (this.video.paused) {
                this.hasCompletedPlayback = true
            }

            this.lastObservedTime = this.video.currentTime
        }

        this.callbacks.onProgressUpdate?.()
    }

    private onTimeUpdate = (): void => {
        if (this.isDisposed) return

        if (isAdShowing(this.player)) {
            if (this.activeClip && this.state !== "waiting-for-ready") {
                this.transitionToWaitingForReady()
            }
            return
        }

        if (this.state === "waiting-for-ready") {
            if (this.readinessWatcher.isReady) {
                this.transitionToSeeking()
            }
            return
        }

        if (this.state === "seeking") {
            return
        }

        if (this.state === "playing" && this.activeClip) {
            if (this.checkPlaybackBoundary()) {
                return
            }

            this.callbacks.onProgressUpdate?.()
        }
    }

    dispose(): void {
        this.isDisposed = true
        this.stopFrameLoop()
        this.readinessWatcher.dispose()
        this.unbindEvents()
        this.lastObservedTime = null
        this.crossedEditEnd = null
        this.ignoreNextBoundarySeekClear = false
        this.hasCompletedPlayback = false
        this.activeClip = null
        this.state = "idle"
    }
}
