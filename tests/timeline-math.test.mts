import assert from "node:assert/strict"
import test from "node:test"
import {
    calculateAnchorAdjustment,
    calculateDefaultRange,
    calculateKeyboardNudge,
    calculateRangeProgress,
    calculateSelectionTrackGeometry,
    calculateTimelineOverlayBounds,
    MIN_CLIP_DURATION,
    snapFrameDuration
} from "../src/content/timelineMath"

test("snapFrameDuration snaps broadcast and web frame rates within tolerance", () => {
    assert.equal(snapFrameDuration(59.94), 1 / 60)
    assert.equal(snapFrameDuration(60.1), 1 / 60)
    assert.equal(snapFrameDuration(29.97), 1 / 30)
    assert.equal(snapFrameDuration(25.0), 1 / 25)
    assert.equal(snapFrameDuration(23.976), 1 / 24)
    assert.equal(snapFrameDuration(50.0), 1 / 50)
    assert.equal(snapFrameDuration(12), null)
    assert.equal(snapFrameDuration(120), null)
})

test("calculateDefaultRange handles empty, short, and standard video durations", () => {
    assert.deepEqual(calculateDefaultRange(15, 0), { start: 0, end: 0 })
    assert.deepEqual(calculateDefaultRange(1, 1.5), { start: 0, end: 1.5 })

    const standard = calculateDefaultRange(20, 100)
    assert.deepEqual(standard, { start: 20, end: 30 })

    const nearEnd = calculateDefaultRange(95, 100)
    assert.deepEqual(nearEnd, { start: 95, end: 100 })

    const pastMaxStart = calculateDefaultRange(99, 100)
    assert.deepEqual(pastMaxStart, { start: 100 - MIN_CLIP_DURATION, end: 100 })
})

test("calculateAnchorAdjustment adjusts start anchor and pushes end when span is too small", () => {
    const range = { start: 10, end: 20 }
    const result = calculateAnchorAdjustment({
        currentRange: range,
        anchor: "start",
        targetTime: 12,
        duration: 100
    })
    assert.ok(result)
    assert.deepEqual(result.nextRange, { start: 12, end: 20 })
    assert.equal(result.updatedTime, 12)

    // Moving start past end - minDuration pushes end forward
    const pushEnd = calculateAnchorAdjustment({
        currentRange: range,
        anchor: "start",
        targetTime: 19.5,
        duration: 100
    })
    assert.ok(pushEnd)
    assert.deepEqual(pushEnd.nextRange, { start: 19.5, end: 19.5 + MIN_CLIP_DURATION })

    // Threshold ignores negligible movements
    const negligible = calculateAnchorAdjustment({
        currentRange: range,
        anchor: "start",
        targetTime: 10.005,
        duration: 100,
        threshold: 0.01
    })
    assert.equal(negligible, null)
})

test("calculateAnchorAdjustment adjusts end anchor and pushes start when span is too small", () => {
    const range = { start: 10, end: 20 }
    const result = calculateAnchorAdjustment({
        currentRange: range,
        anchor: "end",
        targetTime: 18,
        duration: 100
    })
    assert.ok(result)
    assert.deepEqual(result.nextRange, { start: 10, end: 18 })
    assert.equal(result.updatedTime, 18)

    // Moving end before start + minDuration pushes start backward
    const pushStart = calculateAnchorAdjustment({
        currentRange: range,
        anchor: "end",
        targetTime: 11,
        duration: 100
    })
    assert.ok(pushStart)
    assert.deepEqual(pushStart.nextRange, { start: 11 - MIN_CLIP_DURATION, end: 11 })
})

test("calculateKeyboardNudge maps keys and modifiers to time deltas", () => {
    const frame = 1 / 30

    // Arrow keys
    assert.equal(calculateKeyboardNudge("ArrowRight", {}, frame), 5)
    assert.equal(calculateKeyboardNudge("ArrowLeft", {}, frame), -5)
    assert.equal(calculateKeyboardNudge("ArrowRight", { shiftKey: true }, frame), 1)
    assert.equal(calculateKeyboardNudge("ArrowLeft", { shiftKey: true }, frame), -1)
    assert.equal(calculateKeyboardNudge("ArrowRight", { altKey: true }, frame), frame)
    assert.equal(calculateKeyboardNudge("ArrowLeft", { altKey: true }, frame), -frame)

    // 10-second jumps
    assert.equal(calculateKeyboardNudge("l", {}, frame), 10)
    assert.equal(calculateKeyboardNudge("L", {}, frame), 10)
    assert.equal(calculateKeyboardNudge("j", {}, frame), -10)
    assert.equal(calculateKeyboardNudge("J", {}, frame), -10)

    // Frame nudges
    assert.equal(calculateKeyboardNudge(".", {}, frame), frame)
    assert.equal(calculateKeyboardNudge(">", {}, frame), frame)
    assert.equal(calculateKeyboardNudge(",", {}, frame), -frame)
    assert.equal(calculateKeyboardNudge("<", {}, frame), -frame)

    // Unrelated key
    assert.equal(calculateKeyboardNudge("a", {}, frame), 0)
})

test("calculateSelectionTrackGeometry computes correct pixel offsets and enforces min width", () => {
    const geo = calculateSelectionTrackGeometry({ start: 25, end: 75 }, 100, 1000)
    assert.equal(geo.left, 250)
    assert.equal(geo.width, 500)

    // Narrow span respects min width
    const tiny = calculateSelectionTrackGeometry({ start: 50, end: 50.01 }, 100, 1000, 4)
    assert.equal(tiny.left, 500)
    assert.equal(tiny.width, 4)

    // Empty duration or width
    assert.deepEqual(calculateSelectionTrackGeometry({ start: 0, end: 10 }, 0, 1000), { left: 0, width: 0 })
    assert.deepEqual(calculateSelectionTrackGeometry({ start: 0, end: 10 }, 100, 0), { left: 0, width: 0 })
})

test("calculateRangeProgress calculates normalized progress within range", () => {
    const range = { start: 10, end: 30 }
    assert.equal(calculateRangeProgress(10, range), 0)
    assert.equal(calculateRangeProgress(20, range), 0.5)
    assert.equal(calculateRangeProgress(30, range), 1)
    assert.equal(calculateRangeProgress(5, range), 0)
    assert.equal(calculateRangeProgress(40, range), 1)
})

test("calculateTimelineOverlayBounds calculates overlay offsets relative to rootRect", () => {
    const bounds = {
        left: 100,
        width: 800,
        baseTop: 500,
        visualTop: 520
    }
    const rootRect = {
        top: 50,
        left: 20
    }

    const overlay = calculateTimelineOverlayBounds(bounds, rootRect, 16, 6)
    assert.equal(overlay.left, 80) // 100 - 20
    assert.equal(overlay.width, 800)
    assert.equal(overlay.top, 500 - 50 - 16 - 6) // 428
    assert.equal(overlay.height, 520 - 50 - 428) // 42
})
