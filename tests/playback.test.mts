import assert from "node:assert/strict"
import test from "node:test"
import { ClipPlaybackController } from "../src/content/clipPlaybackController"

interface MockVideoOptions {
    currentTime?: number
    paused?: boolean
    adModuleChildren?: () => number
    adShowing?: () => boolean
}

function createMockMedia(options: MockVideoOptions = {}) {
    const g = globalThis as unknown as Record<string, unknown>
    const hadHTMLMediaElement = "HTMLMediaElement" in g
    const origHTMLMediaElement = g.HTMLMediaElement
    g.HTMLMediaElement = { HAVE_CURRENT_DATA: 2 }

    const hadMutationObserver = "MutationObserver" in g
    const origMutationObserver = g.MutationObserver
    if (!hadMutationObserver) {
        g.MutationObserver = class {
            observe() {}
            disconnect() {}
        }
    }

    const videoListeners = new Map<string, Set<() => void>>()
    const rafCallbacks = new Map<number, () => void>()
    let nextRafId = 1
    let pauseCount = 0
    let playCount = 0

    const video = {
        readyState: 4,
        duration: 100,
        currentTime: options.currentTime ?? 0,
        paused: options.paused ?? false,
        ended: false,
        seeking: false,
        play: () => {
            playCount++
            video.paused = false
            return Promise.resolve()
        },
        pause: () => {
            pauseCount++
            video.paused = true
        },
        requestVideoFrameCallback: (cb: () => void) => {
            const id = nextRafId++
            rafCallbacks.set(id, cb)
            return id
        },
        cancelVideoFrameCallback: (id: number) => {
            rafCallbacks.delete(id)
        },
        addEventListener: (ev: string, fn: () => void) => {
            if (!videoListeners.has(ev)) videoListeners.set(ev, new Set())
            videoListeners.get(ev)?.add(fn)
        },
        removeEventListener: (ev: string, fn: () => void) => {
            videoListeners.get(ev)?.delete(fn)
        }
    }

    const adModule = options.adModuleChildren
        ? {
              get childElementCount() {
                  return options.adModuleChildren!()
              }
          }
        : null

    const player = {
        classList: {
            contains: (cls: string) => (cls === "ad-showing" ? Boolean(options.adShowing?.()) : false)
        },
        querySelector: (sel: string) => (sel === ".video-ads.ytp-ad-module" ? adModule : null)
    }

    return {
        video: video as unknown as HTMLVideoElement,
        rawVideo: video,
        player: player as unknown as HTMLElement,
        rawPlayer: player,
        emit: (ev: string) => {
            for (const fn of videoListeners.get(ev) || []) fn()
        },
        flushFrameCallbacks: () => {
            for (const cb of [...rafCallbacks.values()]) cb()
        },
        getPauseCount: () => pauseCount,
        getPlayCount: () => playCount,
        restore: () => {
            if (hadHTMLMediaElement) {
                g.HTMLMediaElement = origHTMLMediaElement
            } else {
                delete g.HTMLMediaElement
            }
            if (hadMutationObserver) {
                g.MutationObserver = origMutationObserver
            } else {
                delete g.MutationObserver
            }
        }
    }
}

test("ClipPlaybackController caps seek correction retries to prevent infinite loops", () => {
    const media = createMockMedia({ currentTime: 0 })
    const controller = new ClipPlaybackController(media.video, media.player)

    try {
        controller.playClip({
            id: "loop",
            videoId: "dQw4w9WgXcQ",
            title: "Loop",
            videoTitle: "V",
            start: 50,
            end: 60,
            createdAt: 1,
            updatedAt: 1
        })

        assert.equal(media.rawVideo.currentTime, 50)
        // Simulate external script resetting currentTime to 10 on each seeked event
        for (let i = 0; i < 6; i++) {
            media.rawVideo.currentTime = 10
            media.emit("seeked")
        }
        // After MAX_SEEK_CORRECTIONS (3), activeClip clears instead of looping forever
        assert.equal(controller.clip, null)
    } finally {
        controller.dispose()
        media.restore()
    }
})

test("ClipPlaybackController handles ended event and short clips near start window", () => {
    const media = createMockMedia({ currentTime: 99.9 })
    const controller = new ClipPlaybackController(media.video, media.player)

    try {
        controller.playClip({
            id: "at_end",
            videoId: "dQw4w9WgXcQ",
            title: "End",
            videoTitle: "V",
            start: 99.9,
            end: 100,
            createdAt: 1,
            updatedAt: 1
        })
        assert.ok(controller.clip)
        media.rawVideo.currentTime = 100
        media.rawVideo.ended = true
        media.emit("ended")
        assert.equal(controller.clip?.id, "at_end")
        assert.equal(controller.isParkedAtEnd, true)
        media.rawVideo.paused = false
        media.emit("play")
        assert.equal(controller.clip, null)

        // Short < 0.5s clip: starting at currentTime = 10.4 when range is [10.0, 10.3] must re-seek to 10.0
        media.rawVideo.ended = false
        media.rawVideo.currentTime = 10.4
        controller.playClip({
            id: "short",
            videoId: "dQw4w9WgXcQ",
            title: "Short",
            videoTitle: "V",
            start: 10,
            end: 10.3,
            createdAt: 1,
            updatedAt: 1
        })
        assert.equal(media.rawVideo.currentTime, 10)
    } finally {
        controller.dispose()
        media.restore()
    }
})

test("ClipPlaybackController keeps active clip alive while editing, stops on crossing end, and allows range updates", () => {
    let media: ReturnType<typeof createMockMedia> | null = null
    try {
        let isEditing = false
        let currentBoundaryEnd = 20
        let progressUpdates = 0

        media = createMockMedia({
            currentTime: 12
        })

        const controller = new ClipPlaybackController(media.video, media.player, {
            isBoundarySuspended: () => isEditing,
            getSuspendedBoundaryEnd: () => currentBoundaryEnd,
            onProgressUpdate: () => {
                progressUpdates++
            }
        })

        controller.playClip({
            id: "edit1",
            videoId: "dQw4w9WgXcQ",
            title: "Edit",
            videoTitle: "V",
            start: 10,
            end: 20,
            createdAt: 1,
            updatedAt: 1
        })
        media.rawVideo.currentTime = 15
        media.emit("seeked")
        assert.equal(controller.clip?.id, "edit1")
        assert.equal(media.getPauseCount(), 0)

        // Playing across boundary end (15 -> 20.12) while editing pauses at 20 while keeping clip card active
        isEditing = true
        const beforeUpdates = progressUpdates
        media.rawVideo.currentTime = 20.12
        media.flushFrameCallbacks()
        assert.equal(media.getPauseCount(), 1)
        assert.equal(media.rawVideo.paused, true)
        assert.equal(media.rawVideo.currentTime, 20)
        assert.equal(controller.clip?.id, "edit1")
        assert.ok(progressUpdates > beforeUpdates)

        // Browser decoder landing slightly below boundaryEnd (19.985) on our snap seek must NOT clear crossedEditEnd
        media.rawVideo.currentTime = 19.985
        media.emit("seeked")

        // Resuming playback when already at/past end (19.985 -> 21.5) must NOT stop again
        media.rawVideo.paused = false
        media.emit("play")
        media.rawVideo.currentTime = 21.5
        media.emit("timeupdate")
        assert.equal(media.getPauseCount(), 1)
        assert.equal(media.rawVideo.paused, false)
        assert.equal(controller.clip?.id, "edit1")

        // Seeking past end directly (15 -> 25 via scrub) does not count as playing through end
        media.rawVideo.seeking = true
        media.rawVideo.currentTime = 15
        media.emit("seeking")
        media.rawVideo.seeking = false
        media.emit("seeked")
        media.rawVideo.seeking = true
        media.emit("seeking")
        media.rawVideo.currentTime = 25
        media.emit("timeupdate")
        media.rawVideo.seeking = false
        media.emit("seeked")
        media.rawVideo.currentTime = 26
        media.emit("timeupdate")
        assert.equal(media.getPauseCount(), 1)
        assert.equal(media.rawVideo.paused, false)
        assert.equal(controller.clip?.id, "edit1")

        // Seeking before start (5) or hitting ended in edit mode keeps activeClip selected
        media.rawVideo.seeking = true
        media.emit("seeking")
        media.rawVideo.currentTime = 5
        media.rawVideo.seeking = false
        media.emit("seeked")
        media.rawVideo.ended = true
        media.emit("ended")
        media.rawVideo.ended = false
        assert.equal(media.getPauseCount(), 1)
        assert.equal(controller.clip?.id, "edit1")

        // Seeking back before 20 (to 18) and playing across 20 stops again cleanly
        media.rawVideo.seeking = true
        media.emit("seeking")
        media.rawVideo.currentTime = 18
        media.rawVideo.seeking = false
        media.emit("seeked")
        media.rawVideo.paused = false
        media.emit("play")
        media.rawVideo.currentTime = 20.01
        media.emit("timeupdate")
        assert.equal(media.getPauseCount(), 2)
        assert.equal(media.rawVideo.paused, true)
        assert.equal(controller.clip?.id, "edit1")

        // Saving extended range [10, 25] while playing at 22 keeps activeClip until 25
        media.rawVideo.paused = false
        media.rawVideo.currentTime = 22
        currentBoundaryEnd = 25
        controller.updateActiveClipRange(10, 25)
        isEditing = false
        controller.reconcileActiveClip()
        assert.equal(controller.clip?.id, "edit1")
        assert.equal(controller.clip?.end, 25)
        assert.equal(media.getPauseCount(), 2)

        media.rawVideo.currentTime = 25
        media.emit("timeupdate")
        assert.equal(media.getPauseCount(), 3)
        assert.equal(controller.clip?.id, "edit1")
        assert.equal(controller.isParkedAtEnd, true)

        // Resuming playback after parking at clip.end smoothly releases active clip without pausing again
        media.rawVideo.paused = false
        media.emit("play")
        assert.equal(controller.clip, null)
        assert.equal(media.getPauseCount(), 3)

        controller.dispose()
        assert.ok(media.getPlayCount() >= 1)
    } finally {
        media?.restore()
    }
})

test("ClipPlaybackController preserves activeClip when exiting edit while paused at clip.end, and clears on cancel past end", () => {
    let media: ReturnType<typeof createMockMedia> | null = null
    try {
        let isEditing = false
        media = createMockMedia({
            currentTime: 10,
            paused: false
        })

        const controller = new ClipPlaybackController(media.video, media.player, {
            isBoundarySuspended: () => isEditing,
            getSuspendedBoundaryEnd: () => 20
        })

        controller.playClip({
            id: "edit2",
            videoId: "dQw4w9WgXcQ",
            title: "Edit 2",
            videoTitle: "V",
            start: 10,
            end: 20,
            createdAt: 1,
            updatedAt: 1
        })
        media.rawVideo.currentTime = 12
        media.emit("seeked")
        isEditing = true
        media.rawVideo.paused = true
        media.rawVideo.currentTime = 20
        isEditing = false
        controller.reconcileActiveClip()
        assert.equal(controller.clip?.id, "edit2")
        assert.equal(controller.isParkedAtEnd, true)

        // Canceling while playing past clip.end clears active clip without forcing video pause
        media.rawVideo.paused = false
        media.rawVideo.currentTime = 26
        const pausesBeforeCancel = media.getPauseCount()
        controller.reconcileActiveClip()
        assert.equal(controller.clip, null)
        assert.equal(media.getPauseCount(), pausesBeforeCancel)

        controller.dispose()
    } finally {
        media?.restore()
    }
})

test("ClipPlaybackController transitions to waiting-for-ready on mid-roll ad during edit exit rather than clearing", () => {
    let media: ReturnType<typeof createMockMedia> | null = null
    try {
        let isEditing = false
        let adShowing = false
        media = createMockMedia({
            currentTime: 12,
            adShowing: () => adShowing
        })

        const controller = new ClipPlaybackController(media.video, media.player, {
            isBoundarySuspended: () => isEditing,
            getSuspendedBoundaryEnd: () => 20
        })

        controller.playClip({
            id: "edit3",
            videoId: "dQw4w9WgXcQ",
            title: "Edit 3",
            videoTitle: "V",
            start: 10,
            end: 20,
            createdAt: 1,
            updatedAt: 1
        })
        media.emit("seeked")
        isEditing = true
        adShowing = true
        media.rawVideo.currentTime = 1
        isEditing = false
        controller.reconcileActiveClip()
        assert.equal(controller.clip?.id, "edit3")

        controller.dispose()
    } finally {
        media?.restore()
    }
})

test("ClipPlaybackController detects paused ad-module clearance during waiting-for-ready", () => {
    const g = globalThis as unknown as Record<string, unknown>
    const origMutationObserver = g.MutationObserver
    const observerCallbacks: (() => void)[] = []
    g.MutationObserver = class {
        constructor(cb: () => void) {
            observerCallbacks.push(cb)
        }
        observe() {}
        disconnect() {}
    }

    let media: ReturnType<typeof createMockMedia> | null = null
    try {
        let adModuleChildren = 1
        media = createMockMedia({
            currentTime: 0,
            paused: true,
            adModuleChildren: () => adModuleChildren
        })

        const controller = new ClipPlaybackController(media.video, media.player)
        controller.playClip({
            id: "adReady1",
            videoId: "dQw4w9WgXcQ",
            title: "AdReady",
            videoTitle: "V",
            start: 15,
            end: 25,
            createdAt: 1,
            updatedAt: 1
        })
        assert.equal(media.rawVideo.currentTime, 0)
        assert.equal(observerCallbacks.length, 2)

        // Ad clears out of .ytp-ad-module while video is paused (no class change on player)
        adModuleChildren = 0
        observerCallbacks[1]()
        assert.equal(media.rawVideo.currentTime, 15)
        controller.dispose()
    } finally {
        media?.restore()
        g.MutationObserver = origMutationObserver
    }
})

test("ClipPlaybackController does not hijack in-flight seek past clip.end back to clip.end", () => {
    const media = createMockMedia({ currentTime: 10 })
    const controller = new ClipPlaybackController(media.video, media.player)

    try {
        controller.playClip({
            id: "seekPastEnd",
            videoId: "dQw4w9WgXcQ",
            title: "Seek",
            videoTitle: "V",
            start: 10,
            end: 20,
            createdAt: 1,
            updatedAt: 1
        })
        assert.equal(controller.clip?.id, "seekPastEnd")

        // User scrubs to 40 while video.seeking is true and timeupdate fires mid-seek
        media.rawVideo.seeking = true
        media.rawVideo.currentTime = 40
        media.emit("timeupdate")
        assert.equal(media.getPauseCount(), 0)
        assert.equal(media.rawVideo.currentTime, 40)

        // Once seek completes, onSeeked clears activeClip while leaving video at 40 playing
        media.rawVideo.seeking = false
        media.emit("seeked")
        assert.equal(controller.clip, null)
        assert.equal(media.rawVideo.currentTime, 40)
        assert.equal(media.getPauseCount(), 0)
    } finally {
        controller.dispose()
        media.restore()
    }
})

test("ClipPlaybackController rebinds adModuleObserver when .ytp-ad-module node is replaced", () => {
    const g = globalThis as unknown as Record<string, unknown>
    const origMutationObserver = g.MutationObserver
    interface TrackedObserver {
        cb: () => void
        target: unknown
        disconnected: boolean
    }
    const observers: TrackedObserver[] = []
    g.MutationObserver = class {
        private record: TrackedObserver
        constructor(cb: () => void) {
            this.record = { cb, target: null, disconnected: false }
            observers.push(this.record)
        }
        observe(target: unknown) {
            this.record.target = target
        }
        disconnect() {
            this.record.disconnected = true
        }
    }

    let media: ReturnType<typeof createMockMedia> | null = null
    try {
        const adChildrenA = 1
        let adChildrenB = 1
        const adModuleA = {
            get childElementCount() {
                return adChildrenA
            }
        }
        const adModuleB = {
            get childElementCount() {
                return adChildrenB
            }
        }
        let currentAdModule = adModuleA

        media = createMockMedia({ currentTime: 0, paused: true })
        media.rawPlayer.querySelector = (sel: string) => (sel === ".video-ads.ytp-ad-module" ? currentAdModule : null)

        const controller = new ClipPlaybackController(media.video, media.player)
        controller.playClip({
            id: "adSwap1",
            videoId: "dQw4w9WgXcQ",
            title: "AdSwap",
            videoTitle: "V",
            start: 18,
            end: 28,
            createdAt: 1,
            updatedAt: 1
        })

        const playerObs = observers[0]
        const firstAdObs = observers[1]
        assert.equal(firstAdObs.target, adModuleA)
        assert.equal(firstAdObs.disconnected, false)

        // Replace .ytp-ad-module in DOM and trigger player mutation
        currentAdModule = adModuleB
        playerObs.cb()

        assert.equal(firstAdObs.disconnected, true)
        assert.equal(observers.length, 3)
        const secondAdObs = observers[2]
        assert.equal(secondAdObs.target, adModuleB)
        assert.equal(secondAdObs.disconnected, false)

        // Clear ad on the replacement node while leaving stale node populated
        adChildrenB = 0
        secondAdObs.cb()
        assert.equal(media.rawVideo.currentTime, 18)
        controller.dispose()
    } finally {
        media?.restore()
        g.MutationObserver = origMutationObserver
    }
})

test("ClipPlaybackController sticky clip model allows uninterrupted play-through past end and resets on backward seek", () => {
    const media = createMockMedia({ currentTime: 10 })
    const controller = new ClipPlaybackController(media.video, media.player)

    try {
        controller.playClip({
            id: "sticky1",
            videoId: "dQw4w9WgXcQ",
            title: "Sticky",
            videoTitle: "V",
            start: 10,
            end: 20,
            createdAt: 1,
            updatedAt: 1
        })
        assert.equal(controller.clip?.id, "sticky1")
        assert.equal(controller.isParkedAtEnd, false)

        // Simulate playback reaching end of clip
        media.rawVideo.currentTime = 20
        media.emit("timeupdate")
        assert.equal(media.getPauseCount(), 1)
        assert.equal(controller.clip?.id, "sticky1")
        assert.equal(controller.isParkedAtEnd, true)

        // Seeking backward inside the clip un-parks it so boundary will stop again
        media.rawVideo.currentTime = 15
        media.emit("seeked")
        assert.equal(controller.clip?.id, "sticky1")
        assert.equal(controller.isParkedAtEnd, false)

        // Playing again reaches end and re-parks
        media.rawVideo.currentTime = 20
        media.emit("timeupdate")
        assert.equal(media.getPauseCount(), 2)
        assert.equal(controller.clip?.id, "sticky1")
        assert.equal(controller.isParkedAtEnd, true)

        // Clicking play while parked at end releases active clip smoothly without pausing
        media.rawVideo.paused = false
        media.emit("play")
        assert.equal(controller.clip, null)
        assert.equal(controller.isParkedAtEnd, false)
        assert.equal(media.getPauseCount(), 2)

        // Subsequent ticks continue playing past end uninterrupted
        media.rawVideo.currentTime = 21
        media.emit("timeupdate")
        assert.equal(media.getPauseCount(), 2)
    } finally {
        controller.dispose()
        media.restore()
    }
})
