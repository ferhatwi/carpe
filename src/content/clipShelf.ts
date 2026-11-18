import cloudAlertIcon from "../../icons/cloud_alert_outlined.svg"
import { t } from "../i18n/index"
import { getSyncedClipIds, getSyncSettings, readClips } from "../storage/index"
import { type ActiveClip, type Clip } from "../types"
import { createElement } from "../utils/dom"
import { clamp, formatClipTime } from "../utils/time"

export interface ClipShelfCallbacks {
    onClipClick: (clip: Clip) => void
    isHidden?: () => boolean
}

interface ProgressEntry {
    id: string
    button: HTMLButtonElement
    bar: HTMLElement
}

function createShelfClipItem(
    clip: Clip,
    isSynced: boolean,
    showSyncAlerts: boolean,
    onClipClick: (clip: Clip) => void
): ProgressEntry {
    const clipTitle = clip.title || t("untitledClip")
    const timeRange = `${formatClipTime(clip.start)} - ${formatClipTime(clip.end)}`

    const title = createElement("span", {
        className: "carpe-video-clip-title",
        textContent: clipTitle
    })

    const timeChildren: (Node | string)[] = [timeRange]
    if (showSyncAlerts && !isSynced) {
        timeChildren.push(
            createElement("span", {
                className: "carpe-video-clip-sync-alert",
                title: t("shelfLocalOnlyTooltip"),
                svgIcon: cloudAlertIcon
            })
        )
    }

    const time = createElement("span", {
        className: "carpe-video-clip-time",
        attributes: { dir: "ltr" },
        children: timeChildren
    })

    const progressBar = createElement("span", { className: "carpe-video-clip-progress" })
    const progressTrack = createElement("span", {
        className: "carpe-video-clip-track",
        children: [progressBar]
    })

    const item = createElement("button", {
        type: "button",
        className: "carpe-video-clip",
        title: `${clipTitle} (${timeRange})`,
        ariaPressed: "false",
        attributes: { "data-clip-id": clip.id },
        children: [title, time, progressTrack]
    })

    item.addEventListener("click", (event) => {
        event.stopPropagation()
        onClipClick(clip)
    })
    item.addEventListener("pointerdown", (event) => event.stopPropagation())

    return { id: clip.id, button: item, bar: progressBar }
}

/**
 * Manages the horizontal carousel of saved clips displayed above the YouTube scrubber bar.
 */
export class ClipShelf {
    private readonly videoId: string
    private readonly video: HTMLVideoElement
    private readonly container: HTMLElement
    private readonly callbacks: ClipShelfCallbacks
    private progressEntries: ProgressEntry[] = []
    private isDisposed = false
    private loadSeq = 0

    constructor(videoId: string, video: HTMLVideoElement, container: HTMLElement, callbacks: ClipShelfCallbacks) {
        this.videoId = videoId
        this.video = video
        this.container = container
        this.callbacks = callbacks
    }

    async loadClips(): Promise<void> {
        if (this.isDisposed) return
        const seq = ++this.loadSeq
        const [clips, settings] = await Promise.all([readClips(), getSyncSettings()])
        const syncedIds = settings.syncEnabled
            ? await getSyncedClipIds().catch(() => new Set<string>())
            : new Set<string>()
        if (this.isDisposed || seq !== this.loadSeq) return
        this.renderClips(clips, syncedIds, settings.syncEnabled)
    }

    private renderClips(clips: Clip[], syncedIds: Set<string>, showSyncAlerts: boolean): void {
        const matchingClips = clips
            .filter((clip) => {
                return (
                    clip.videoId === this.videoId &&
                    Number.isFinite(Number(clip.start)) &&
                    Number.isFinite(Number(clip.end)) &&
                    Number(clip.end) > Number(clip.start)
                )
            })
            .sort((a, b) => Number(a.start) - Number(b.start))

        this.progressEntries = matchingClips.map((clip) =>
            createShelfClipItem(clip, syncedIds.has(clip.id), showSyncAlerts, this.callbacks.onClipClick)
        )

        this.container.replaceChildren(...this.progressEntries.map((entry) => entry.button))
        this.container.hidden = matchingClips.length === 0 || Boolean(this.callbacks.isHidden?.())
    }

    updateProgress(activeClip: ActiveClip | null): void {
        if (this.isDisposed) return

        for (const entry of this.progressEntries) {
            const isActive = Boolean(activeClip && entry.id === activeClip.id)
            const progress =
                isActive && activeClip
                    ? clamp((this.video.currentTime - activeClip.start) / (activeClip.end - activeClip.start), 0, 1)
                    : 0

            entry.button.classList.toggle("active", isActive)
            entry.button.setAttribute("aria-pressed", String(isActive))
            entry.bar.style.transform = `scaleX(${progress})`
        }
    }

    dispose(): void {
        this.isDisposed = true
        this.progressEntries = []
        this.container.replaceChildren()
    }
}
