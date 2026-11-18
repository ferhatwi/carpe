import type { WatchContext } from "../types"

export function getPlayer(): HTMLElement | null {
    return (
        document.querySelector<HTMLElement>("#movie_player") ||
        document.querySelector<HTMLElement>(".html5-video-player")
    )
}

export function getVideo(player: HTMLElement): HTMLVideoElement | null {
    return player.querySelector<HTMLVideoElement>("video")
}

export function resolveWatchContext(): WatchContext | null {
    const videoId = getVideoId()
    if (!videoId) return null

    const player = getPlayer()
    if (!player) return null

    const video = getVideo(player)
    if (!video) return null

    return { videoId, video, player }
}

export interface TimelineBounds {
    left: number
    width: number
    baseTop: number
    visualTop: number
}

function findTimelineBar(player: Element): { element: HTMLElement | null; rect: DOMRect } {
    const progressBar =
        player.querySelector<HTMLElement>(".ytp-progress-bar") ||
        player.querySelector<HTMLElement>(".ytp-progress-bar-container")

    const progressRect = progressBar?.getBoundingClientRect()
    if (progressBar && progressRect && progressRect.width > 0 && progressRect.height > 0) {
        return { element: progressBar, rect: progressRect }
    }

    return {
        element: null,
        rect: {
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            width: 0,
            height: 0,
            x: 0,
            y: 0,
            toJSON: () => ({})
        } as DOMRect
    }
}

/**
 * Returns horizontal timeline bounds along with both the stable progress-bar top
 * and the current visual top of the rendered track (accounting for hover scaling).
 */
export function getTimelineBounds(player: Element, startRatio = 0, endRatio = 1): TimelineBounds {
    const { element: progressBar, rect: baseRect } = findTimelineBar(player)

    let visualTop = baseRect.top
    if (progressBar) {
        const rangeLeft = baseRect.left + startRatio * baseRect.width
        const rangeRight = baseRect.left + endRatio * baseRect.width
        const listRects: DOMRect[] = []

        progressBar.querySelectorAll<HTMLElement>(".ytp-progress-list").forEach((list) => {
            const rect = list.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) {
                listRects.push(rect)
            }
        })

        if (listRects.length > 0) {
            const overlapping = listRects.filter((rect) => rect.right >= rangeLeft - 1 && rect.left <= rangeRight + 1)
            const candidates = overlapping.length > 0 ? overlapping : listRects
            visualTop = Math.min(...candidates.map((rect) => rect.top))
        }
    }

    return {
        left: baseRect.left,
        width: baseRect.width,
        baseTop: baseRect.top,
        visualTop
    }
}

export function getVideoId(): string | null {
    try {
        return new URL(location.href).searchParams.get("v")
    } catch {
        return null
    }
}

export const MAX_CLIP_TITLE_LENGTH = 60

export function normalizeTitle(title?: string | null): string {
    return (title || "").replace(/\s+/g, " ").trim()
}

export function sanitizeClipTitle(title?: string | null): string {
    return normalizeTitle(title).slice(0, MAX_CLIP_TITLE_LENGTH)
}

export function sanitizeTitle(title?: string | null): string {
    return normalizeTitle((title || "").replace(/^\s*\(\d+\+?\)\s*/, "").replace(/\s*-\s*YouTube$/i, ""))
}

export function getVideoTitle(): string {
    const domTitle = document
        .querySelector("h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string, h1.title")
        ?.textContent?.trim()

    if (domTitle) return normalizeTitle(domTitle)

    return sanitizeTitle(document.title)
}

export function getDuration(video: HTMLVideoElement): number {
    return Number.isFinite(video.duration) ? video.duration : 0
}

export function isAdShowing(player: HTMLElement): boolean {
    if (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting")) {
        return true
    }

    if (player.querySelector(".ytp-ad-player-overlay")) return true

    const adModule = player.querySelector(".video-ads.ytp-ad-module")
    if (adModule && adModule.childElementCount > 0) return true

    return false
}
