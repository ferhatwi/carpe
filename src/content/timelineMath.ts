import { type SelectionRange } from "../types"
import { clamp } from "../utils/time"

export const MIN_CLIP_DURATION = 2
export const DEFAULT_RANGE_SECONDS = 10
export const PSEUDO_TIMELINE_HEIGHT = 6
export const PSEUDO_TIMELINE_GAP = 16
export const MIN_SELECTION_WIDTH_PX = 2
export const HOVER_SYNC_DURATION_MS = 220
export const DEFAULT_FRAME_DURATION = 1 / 30
export const STANDARD_FRAME_RATES = [60, 50, 30, 25, 24] as const

/**
 * Snaps an estimated frame rate (fps) to the closest standard broadcast/web rate within 12% tolerance.
 */
export function snapFrameDuration(fps: number): number | null {
    let closestRate: number | null = null
    let minError = Infinity
    for (const rate of STANDARD_FRAME_RATES) {
        const error = Math.abs(fps - rate) / rate
        if (error <= 0.12 && error < minError) {
            minError = error
            closestRate = rate
        }
    }
    return closestRate !== null ? 1 / closestRate : null
}

/**
 * Calculates a default selection range from the current video playhead.
 */
export function calculateDefaultRange(currentTime: number, duration: number): SelectionRange {
    if (!duration || duration <= 0) {
        return { start: 0, end: 0 }
    }
    if (duration <= MIN_CLIP_DURATION) {
        return { start: 0, end: duration }
    }
    const maxStart = duration - MIN_CLIP_DURATION
    const start = clamp(currentTime, 0, maxStart)
    const preferredEnd = Math.min(duration, start + DEFAULT_RANGE_SECONDS)
    return { start, end: preferredEnd }
}

export interface AnchorAdjustmentParams {
    currentRange: SelectionRange
    anchor: "start" | "end"
    targetTime: number
    duration: number
    threshold?: number
}

export interface AnchorAdjustmentResult {
    nextRange: SelectionRange
    updatedTime: number
}

/**
 * Adjusts either the start or end anchor of a selection range to targetTime while preserving MIN_CLIP_DURATION.
 * Returns null if the change is within the threshold.
 */
export function calculateAnchorAdjustment(params: AnchorAdjustmentParams): AnchorAdjustmentResult | null {
    const { currentRange, anchor, targetTime, duration, threshold = 0 } = params
    const maxDuration = duration > 0 ? duration : Infinity
    const minSpan = duration > 0 ? Math.min(MIN_CLIP_DURATION, duration) : MIN_CLIP_DURATION

    if (anchor === "start") {
        const maxStart = Math.max(0, maxDuration - minSpan)
        const nextStart = clamp(targetTime, 0, maxStart)
        if (Math.abs(currentRange.start - nextStart) > threshold) {
            const nextEnd =
                currentRange.end < nextStart + minSpan ? Math.min(maxDuration, nextStart + minSpan) : currentRange.end
            return {
                nextRange: { start: nextStart, end: nextEnd },
                updatedTime: nextStart
            }
        }
        return null
    }

    const nextEnd = clamp(targetTime, minSpan, maxDuration)
    if (Math.abs(currentRange.end - nextEnd) > threshold) {
        const nextStart = currentRange.start > nextEnd - minSpan ? Math.max(0, nextEnd - minSpan) : currentRange.start
        return {
            nextRange: { start: nextStart, end: nextEnd },
            updatedTime: nextEnd
        }
    }
    return null
}

export interface KeyboardNudgeModifiers {
    shiftKey?: boolean
    altKey?: boolean
}

/**
 * Computes time delta in seconds for timeline keyboard shortcuts.
 */
export function calculateKeyboardNudge(key: string, modifiers: KeyboardNudgeModifiers, frameDuration: number): number {
    if (key === "ArrowLeft" || key === "ArrowRight") {
        const step = modifiers.shiftKey ? 1 : modifiers.altKey ? frameDuration : 5
        return key === "ArrowLeft" ? -step : step
    }
    if (key === "j" || key === "J") {
        return -10
    }
    if (key === "l" || key === "L") {
        return 10
    }
    if (key === "," || key === "<") {
        return -frameDuration
    }
    if (key === "." || key === ">") {
        return frameDuration
    }
    return 0
}

export interface TrackGeometry {
    left: number
    width: number
}

/**
 * Computes pixel position (left) and width for the timeline selection highlight bar.
 */
export function calculateSelectionTrackGeometry(
    selection: SelectionRange,
    duration: number,
    timelineWidth: number,
    minWidthPx = MIN_SELECTION_WIDTH_PX
): TrackGeometry {
    if (!duration || duration <= 0 || timelineWidth <= 0) {
        return { left: 0, width: 0 }
    }
    const startRatio = clamp(selection.start / duration, 0, 1)
    const endRatio = clamp(selection.end / duration, 0, 1)
    const startPosition = startRatio * timelineWidth
    const endPosition = endRatio * timelineWidth
    const minWidth = Math.min(minWidthPx, timelineWidth)
    const selectionWidth = Math.max(minWidth, endPosition - startPosition)
    const selectionLeft = clamp(startPosition, 0, Math.max(0, timelineWidth - selectionWidth))
    return {
        left: selectionLeft,
        width: selectionWidth
    }
}

/**
 * Calculates normalized progress [0, 1] within the selection range.
 */
export function calculateRangeProgress(currentTime: number, selection: SelectionRange): number {
    const span = selection.end - selection.start
    if (span > 0) {
        return clamp((currentTime - selection.start) / span, 0, 1)
    }
    return currentTime >= selection.end ? 1 : 0
}

export interface TimelineBounds {
    left: number
    width: number
    baseTop: number
    visualTop: number
}

export interface RootRect {
    top: number
    left: number
}

export interface OverlayBounds {
    left: number
    top: number
    width: number
    height: number
}

export const VIDEO_CLIPS_TOP_FROM_PLAYER = 12
export const VIDEO_CLIPS_FULLSCREEN_TOP_FALLBACK = 68

/**
 * Calculates absolute positioning for the rangeWrap container relative to the root overlay element.
 */
export function calculateTimelineOverlayBounds(
    bounds: TimelineBounds,
    rootRect: RootRect,
    pseudoGap = PSEUDO_TIMELINE_GAP,
    pseudoHeight = PSEUDO_TIMELINE_HEIGHT
): OverlayBounds {
    const pseudoTop = bounds.baseTop - rootRect.top - pseudoGap - pseudoHeight
    const visualTimelineTop = bounds.visualTop - rootRect.top
    const totalHeight = Math.max(pseudoHeight, visualTimelineTop - pseudoTop)
    return {
        left: bounds.left - rootRect.left,
        top: pseudoTop,
        width: bounds.width,
        height: totalHeight
    }
}

export function getClipsTopOffset(player: HTMLElement): number {
    const isFullscreen = player.classList.contains("ytp-fullscreen") || document.fullscreenElement !== null

    if (!isFullscreen) {
        return VIDEO_CLIPS_TOP_FROM_PLAYER
    }

    const chromeTop = player.querySelector<HTMLElement>(".ytp-chrome-top")
    if (chromeTop) {
        const playerTop = player.getBoundingClientRect().top
        const chromeTopRect = chromeTop.getBoundingClientRect()
        if (chromeTopRect.height > 0) {
            const chromeTopBottom = chromeTopRect.bottom - playerTop
            return Math.max(chromeTopBottom + 8, VIDEO_CLIPS_FULLSCREEN_TOP_FALLBACK)
        }
    }

    return VIDEO_CLIPS_FULLSCREEN_TOP_FALLBACK
}
