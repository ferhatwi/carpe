import { type SelectionRange } from "../types"
import { clamp, formatClipTimeWithFrame } from "../utils/time"
import { getDuration, getTimelineBounds, isAdShowing } from "../utils/youtube"
import { VideoFrameRateDetector } from "./frameDetector"
import { PlayerOverlayView } from "./playerOverlayView"
import {
    calculateAnchorAdjustment,
    calculateDefaultRange,
    calculateKeyboardNudge,
    calculateRangeProgress,
    calculateSelectionTrackGeometry,
    calculateTimelineOverlayBounds,
    HOVER_SYNC_DURATION_MS
} from "./timelineMath"

export { MIN_CLIP_DURATION } from "./timelineMath"

export interface TimelineTrimmerCallbacks {
    getHasActiveClip: () => boolean
    onSelectionChange?: () => void
    onCancel?: () => void
}

/**
 * Manages timeline range selection, anchor switching, selection overlay rendering, and keyboard frame nudging.
 */
export class TimelineTrimmer {
    private readonly video: HTMLVideoElement
    private readonly view: PlayerOverlayView
    private readonly callbacks: TimelineTrimmerCallbacks
    private readonly frameDetector: VideoFrameRateDetector

    private selection: SelectionRange | null = null
    private activeAnchor: "start" | "end" | null = null
    private isDisposed = false
    private playbackRafId: number | null = null
    private hoverSyncRafId: number | null = null
    private hoverSyncStartTime = 0
    private observedHoverPlayer: HTMLElement | null = null
    private timelineWidth = 0
    private isProgrammaticSeek = false
    private programmaticSeekToken = 0
    private programmaticSeekTimer: ReturnType<typeof setTimeout> | null = null

    constructor(video: HTMLVideoElement, view: PlayerOverlayView, callbacks: TimelineTrimmerCallbacks) {
        this.video = video
        this.view = view
        this.callbacks = callbacks
        this.frameDetector = new VideoFrameRateDetector(this.video, {
            shouldSample: () => !isAdShowing(this.view.playerElement),
            onDetected: () => this.onFrameRateDetected()
        })

        this.bindEvents()
        this.frameDetector.start()
    }

    get currentSelection(): SelectionRange | null {
        return this.selection
    }

    get currentAnchor(): "start" | "end" | null {
        return this.activeAnchor
    }

    private clearProgrammaticSeek(): void {
        this.isProgrammaticSeek = false
        this.programmaticSeekToken++
        if (this.programmaticSeekTimer !== null) {
            clearTimeout(this.programmaticSeekTimer)
            this.programmaticSeekTimer = null
        }
    }

    private seekVideoPreservingRange(targetTime: number, minDelta = 0.01): void {
        if (!Number.isFinite(targetTime) || Math.abs(this.video.currentTime - targetTime) <= minDelta) {
            return
        }
        this.clearProgrammaticSeek()
        this.isProgrammaticSeek = true
        const token = this.programmaticSeekToken
        const startedAt = performance.now()
        const scheduleTimeout = () => {
            this.programmaticSeekTimer = setTimeout(() => {
                if (token !== this.programmaticSeekToken) {
                    return
                }
                if (this.video.seeking && performance.now() - startedAt < 1500) {
                    scheduleTimeout()
                    return
                }
                this.clearProgrammaticSeek()
            }, 350)
        }
        scheduleTimeout()
        this.video.currentTime = targetTime
    }

    setSelection(range: SelectionRange | null, anchor: "start" | "end" | null = null, seekTo?: number): void {
        this.selection = range ? { ...range } : null
        this.activeAnchor = anchor
        if (this.selection && seekTo !== undefined) {
            this.seekVideoPreservingRange(seekTo)
        }
        if (this.selection) {
            this.frameDetector.start()
        }
        this.render()
    }

    clearSelection(): void {
        this.clearProgrammaticSeek()
        this.selection = null
        this.activeAnchor = null
        this.timelineWidth = 0
        this.render()
    }

    createDefaultRange(): SelectionRange {
        return calculateDefaultRange(this.video.currentTime, getDuration(this.video))
    }

    getFrameDuration(): number {
        return this.frameDetector.frameDuration
    }

    private bindEvents(): void {
        this.video.addEventListener("seeked", this.onVideoSeeked)
        this.video.addEventListener("seeking", this.onVideoTimeUpdate)
        this.video.addEventListener("timeupdate", this.onVideoTimeUpdate)
        this.video.addEventListener("durationchange", this.onDurationChange)
        this.video.addEventListener("play", this.onVideoPlay)
        this.video.addEventListener("pause", this.onVideoPause)
        this.video.addEventListener("ended", this.onVideoPause)
        this.video.addEventListener("resize", this.onVideoResize)
        window.addEventListener("keydown", this.onKeyDown, true)
        this.bindHoverListeners(this.view.playerElement)

        this.view.startTimeButton.onclick = (event) => {
            event.stopPropagation()
            if (!this.selection) return

            if (this.activeAnchor === "start") {
                this.activeAnchor = null
            } else {
                this.activeAnchor = "start"
                this.seekVideoPreservingRange(this.selection.start)
            }
            this.render()
        }

        this.view.endTimeButton.onclick = (event) => {
            event.stopPropagation()
            if (!this.selection) return

            if (this.activeAnchor === "end") {
                this.activeAnchor = null
            } else {
                this.activeAnchor = "end"
                this.seekVideoPreservingRange(this.selection.end)
            }
            this.render()
        }
    }

    private unbindEvents(): void {
        this.clearProgrammaticSeek()
        this.video.removeEventListener("seeked", this.onVideoSeeked)
        this.video.removeEventListener("seeking", this.onVideoTimeUpdate)
        this.video.removeEventListener("timeupdate", this.onVideoTimeUpdate)
        this.video.removeEventListener("durationchange", this.onDurationChange)
        this.video.removeEventListener("play", this.onVideoPlay)
        this.video.removeEventListener("pause", this.onVideoPause)
        this.video.removeEventListener("ended", this.onVideoPause)
        this.video.removeEventListener("resize", this.onVideoResize)
        window.removeEventListener("keydown", this.onKeyDown, true)
        this.view.startTimeButton.onclick = null
        this.view.endTimeButton.onclick = null
        this.unbindHoverListeners()
        this.stopPlaybackSync()
        this.stopHoverSync()
        this.frameDetector.stop()
    }

    private bindHoverListeners(player: HTMLElement | null): void {
        if (!player || player === this.observedHoverPlayer) return
        this.unbindHoverListeners()
        this.observedHoverPlayer = player
        player.addEventListener("pointerover", this.onTimelineHoverEvent)
        player.addEventListener("pointerout", this.onTimelineHoverEvent)
        player.addEventListener("transitionrun", this.onTimelineHoverEvent)
        player.addEventListener("transitionend", this.onTimelineHoverEvent)
    }

    private unbindHoverListeners(): void {
        if (!this.observedHoverPlayer) return
        this.observedHoverPlayer.removeEventListener("pointerover", this.onTimelineHoverEvent)
        this.observedHoverPlayer.removeEventListener("pointerout", this.onTimelineHoverEvent)
        this.observedHoverPlayer.removeEventListener("transitionrun", this.onTimelineHoverEvent)
        this.observedHoverPlayer.removeEventListener("transitionend", this.onTimelineHoverEvent)
        this.observedHoverPlayer = null
    }

    private onDurationChange = (): void => {
        if (this.isDisposed) return
        if (!this.frameDetector.isDetected) {
            this.frameDetector.start()
        }
        if (this.selection) {
            this.render()
        }
    }

    private onVideoPlay = (): void => {
        if (this.isDisposed) return
        this.frameDetector.start()
        if (this.selection) {
            this.startPlaybackSync()
        }
    }

    private onVideoPause = (): void => {
        this.stopPlaybackSync()
        if (!this.isDisposed && this.selection) {
            this.renderProgress()
        }
    }

    private onTimelineHoverEvent = (event: Event): void => {
        if (this.isDisposed || !this.selection) return
        const target = event.target as Element | null
        if (!target?.closest(".ytp-progress-bar-container")) return

        if (event.type === "transitionend") {
            this.stopHoverSync()
            this.render()
            return
        }

        this.render()
        this.startHoverSync()
    }

    private startPlaybackSync(): void {
        if (this.playbackRafId !== null || this.isDisposed || !this.selection || this.video.paused) return

        const tick = () => {
            this.playbackRafId = null
            if (this.isDisposed || !this.selection || this.video.paused) return
            this.onVideoTimeUpdate()
            if (!this.isDisposed && this.selection && !this.video.paused) {
                this.playbackRafId = requestAnimationFrame(tick)
            }
        }

        this.playbackRafId = requestAnimationFrame(tick)
    }

    private stopPlaybackSync(): void {
        if (this.playbackRafId !== null) {
            cancelAnimationFrame(this.playbackRafId)
            this.playbackRafId = null
        }
    }

    private startHoverSync(): void {
        this.hoverSyncStartTime = performance.now()
        if (this.hoverSyncRafId !== null) return

        const tick = (now: number) => {
            this.hoverSyncRafId = null
            if (this.isDisposed || !this.selection) return
            this.render()
            if (now - this.hoverSyncStartTime < HOVER_SYNC_DURATION_MS) {
                this.hoverSyncRafId = requestAnimationFrame(tick)
            }
        }

        this.hoverSyncRafId = requestAnimationFrame(tick)
    }

    private stopHoverSync(): void {
        if (this.hoverSyncRafId !== null) {
            cancelAnimationFrame(this.hoverSyncRafId)
            this.hoverSyncRafId = null
        }
    }

    private onVideoResize = (): void => {
        // Quality switches (e.g. 1080p60 -> 480p30) can change the stream framerate
        if (!this.isDisposed) {
            this.frameDetector.reset()
        }
    }

    private onFrameRateDetected(): void {
        if (!this.isDisposed && this.selection) {
            this.updateAnchorTimeLabels()
        }
    }

    private updateAnchorTimeLabels(): void {
        if (!this.selection) return
        const frameDuration = this.frameDetector.frameDuration
        const startFormatted = formatClipTimeWithFrame(this.selection.start, frameDuration)
        const endFormatted = formatClipTimeWithFrame(this.selection.end, frameDuration)
        this.view.setAnchorTime("start", startFormatted.time, startFormatted.frame)
        this.view.setAnchorTime("end", endFormatted.time, endFormatted.frame)
    }

    private applyAnchorTime(targetTime: number, threshold: number): number | null {
        if (!this.selection || !this.activeAnchor) return null

        const adjusted = calculateAnchorAdjustment({
            currentRange: this.selection,
            anchor: this.activeAnchor,
            targetTime,
            duration: getDuration(this.video),
            threshold
        })

        if (!adjusted) return null
        this.selection = adjusted.nextRange
        return adjusted.updatedTime
    }

    updatePlaybackProgress(): void {
        if (this.isDisposed || !this.selection) return
        this.renderProgress()
    }

    private updateSelectionTrack(duration: number, width: number): void {
        if (!this.selection || !duration || width <= 0) return

        this.updateAnchorTimeLabels()

        const geometry = calculateSelectionTrackGeometry(this.selection, duration, width)
        this.view.rangeSelection.style.left = `${geometry.left}px`
        this.view.rangeSelection.style.width = `${geometry.width}px`
        this.renderProgress()
    }

    private onVideoSeeked = (): void => {
        if (this.isDisposed || !this.selection) return
        if (this.isProgrammaticSeek) {
            if (this.video.seeking) {
                this.renderProgress()
                return
            }
            this.clearProgrammaticSeek()
            this.renderProgress()
            return
        }
        this.onVideoTimeUpdate()
    }

    private onVideoTimeUpdate = (): void => {
        if (this.isDisposed || !this.selection) return
        if (this.isProgrammaticSeek) {
            this.renderProgress()
            return
        }

        if (!this.activeAnchor) {
            this.renderProgress()
            return
        }

        if (this.applyAnchorTime(this.video.currentTime, 0.01) !== null) {
            this.callbacks.onSelectionChange?.()
            const duration = getDuration(this.video)
            if (this.timelineWidth > 0 && duration > 0) {
                this.updateSelectionTrack(duration, this.timelineWidth)
            } else {
                this.render()
            }
            return
        }

        this.renderProgress()
    }

    private onKeyDown = (event: KeyboardEvent): void => {
        if (this.isDisposed || !this.selection) {
            return
        }

        if (event.ctrlKey || event.metaKey) {
            return
        }

        if (
            event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLTextAreaElement ||
            (event.target instanceof HTMLElement && event.target.isContentEditable)
        ) {
            return
        }

        if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            if (this.activeAnchor) {
                this.activeAnchor = null
                this.render()
            } else {
                this.callbacks.onCancel?.()
            }
            return
        }

        if (!this.activeAnchor) {
            return
        }

        const isInteractiveControl =
            event.target instanceof Element && Boolean(event.target.closest("button, a, [role='button']"))

        if (event.key === "Enter" && !isInteractiveControl) {
            event.preventDefault()
            event.stopPropagation()
            this.activeAnchor = null
            this.render()
            return
        }

        const frameDuration = this.getFrameDuration()
        const delta = calculateKeyboardNudge(event.key, event, frameDuration)

        if (delta !== 0) {
            event.preventDefault()
            event.stopPropagation()

            const baseTime = this.activeAnchor === "start" ? this.selection.start : this.selection.end
            const updatedTime = this.applyAnchorTime(baseTime + delta, 0)
            if (updatedTime !== null) {
                this.callbacks.onSelectionChange?.()
                this.seekVideoPreservingRange(updatedTime, 0)
            }

            this.render()
        }
    }

    private updateControlsVisibility(hasSelection: boolean, hasActiveClip: boolean): void {
        const player = this.view.playerElement
        if (player.isConnected) {
            player.classList.toggle("carpe-selecting", hasSelection)
        }

        this.view.button.hidden = hasSelection || hasActiveClip
        this.view.editButton.hidden = hasSelection || !hasActiveClip
        this.view.deleteButton.hidden = hasSelection || !hasActiveClip

        this.view.titleInput.hidden = !hasSelection
        this.view.saveButton.hidden = !hasSelection
        this.view.cancelButton.hidden = !hasSelection
        this.view.timeDisplay.hidden = !hasSelection

        if (hasSelection && this.selection) {
            const isStartActive = this.activeAnchor === "start"
            const isEndActive = this.activeAnchor === "end"
            this.view.startTimeButton.classList.toggle("active", isStartActive)
            this.view.startTimeButton.setAttribute("aria-pressed", String(isStartActive))
            this.view.endTimeButton.classList.toggle("active", isEndActive)
            this.view.endTimeButton.setAttribute("aria-pressed", String(isEndActive))
        }
    }

    private updateOverlayPosition(player: HTMLElement, startRatio: number, endRatio: number): number {
        if (!player.isConnected) {
            return this.view.rangeWrap.clientWidth
        }

        this.bindHoverListeners(player)
        const bounds = getTimelineBounds(player, startRatio, endRatio)
        if (bounds.width <= 0) {
            return 0
        }

        const rootRect = this.view.root.getBoundingClientRect()
        const overlayBounds = calculateTimelineOverlayBounds(bounds, rootRect)

        this.view.rangeWrap.style.left = `${overlayBounds.left}px`
        this.view.rangeWrap.style.right = "auto"
        this.view.rangeWrap.style.width = `${overlayBounds.width}px`
        this.view.rangeWrap.style.top = `${overlayBounds.top}px`
        this.view.rangeWrap.style.height = `${overlayBounds.height}px`
        this.view.rangeWrap.style.bottom = "auto"

        return bounds.width
    }

    render(): void {
        if (this.isDisposed) return

        const duration = getDuration(this.video)
        const hasSelection = Boolean(this.selection && duration)
        const hasActiveClip = this.callbacks.getHasActiveClip()
        const player = this.view.playerElement

        this.updateControlsVisibility(hasSelection, hasActiveClip)

        if (!hasSelection || !this.selection) {
            this.timelineWidth = 0
            this.stopPlaybackSync()
            this.stopHoverSync()
            this.view.rangeWrap.classList.remove("visible")
            return
        }

        this.updateAnchorTimeLabels()

        const startRatio = clamp(this.selection.start / duration, 0, 1)
        const endRatio = clamp(this.selection.end / duration, 0, 1)
        const timelineWidth = this.updateOverlayPosition(player, startRatio, endRatio)

        if (player.isConnected && timelineWidth <= 0) {
            this.timelineWidth = 0
            this.view.rangeWrap.classList.remove("visible")
            return
        }

        this.timelineWidth = timelineWidth
        this.updateSelectionTrack(duration, timelineWidth)
        this.view.rangeWrap.classList.add("visible")

        if (!this.video.paused) {
            this.startPlaybackSync()
        }
    }

    private renderProgress(): void {
        if (this.isDisposed || !this.selection) return
        const progress = calculateRangeProgress(this.video.currentTime, this.selection)
        this.view.pseudoTimelineProgress.style.transform = `scaleX(${progress})`
    }

    dispose(): void {
        this.isDisposed = true
        this.unbindEvents()
        this.selection = null
        this.activeAnchor = null
        this.frameDetector.dispose()
        this.view.playerElement.classList.remove("carpe-selecting")
    }
}
