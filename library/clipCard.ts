import { t } from "../src/i18n/index"
import { Clip } from "../src/types"
import { createElement } from "../src/utils/dom"
import { formatLibraryTime } from "../src/utils/time"
import { applyCardAmbientColor, extractAverageHueFromElement } from "./thumbnailColor"

export interface ClipCardActions {
    onOpen: (clip: Clip) => void
    onDelete: (clip: Clip) => void
}

function setupCardThumbnail(
    image: HTMLImageElement,
    encodedVideoId: string,
    card: HTMLElement,
    cleanTitle: string
): void {
    const primaryUrl = `https://i.ytimg.com/vi/${encodedVideoId}/maxresdefault.jpg`
    const fallbackUrl = `https://i.ytimg.com/vi/${encodedVideoId}/hqdefault.jpg`

    let triedCors = true
    image.crossOrigin = "anonymous"

    image.onload = () => {
        // YouTube serves a 120x90 placeholder JPEG when maxresdefault does not exist
        if (image.naturalWidth <= 120 && image.src !== fallbackUrl) {
            image.src = fallbackUrl
            return
        }
        const hue = extractAverageHueFromElement(image)
        if (hue !== null) {
            applyCardAmbientColor(card, hue)
        }
    }

    image.onerror = () => {
        if (image.src !== fallbackUrl) {
            image.src = fallbackUrl
            return
        }
        if (triedCors) {
            triedCors = false
            image.removeAttribute("crossorigin")
            const retryUrl = image.src
            image.src = ""
            image.src = retryUrl
        }
    }

    image.src = primaryUrl
    image.alt = cleanTitle
}

export function createClipCardElement(
    template: HTMLTemplateElement,
    clip: Clip,
    isSynced: boolean,
    showSyncAlerts: boolean,
    actions: ClipCardActions
): DocumentFragment | null {
    const fragment = template.content.cloneNode(true) as DocumentFragment
    const card = fragment.querySelector<HTMLElement>(".clip-card")
    const trigger = fragment.querySelector<HTMLButtonElement>(".clip-trigger")
    const image = fragment.querySelector<HTMLImageElement>(".clip-thumbnail")
    const title = fragment.querySelector<HTMLElement>(".clip-title")
    const videoTitle = fragment.querySelector<HTMLElement>(".clip-video-title")
    const range = fragment.querySelector<HTMLElement>(".clip-range")
    const deleteButton = fragment.querySelector<HTMLButtonElement>(".clip-delete")
    const syncBadge = fragment.querySelector<HTMLElement>(".clip-sync-badge")

    if (!card || !trigger || !image || !title || !videoTitle || !range || !deleteButton) {
        return null
    }

    const cleanTitle = clip.title || t("untitledClip")
    const cleanVideoTitle = clip.videoTitle || t("defaultVideoTitle")
    const encodedVideoId = encodeURIComponent(clip.videoId)

    setupCardThumbnail(image, encodedVideoId, card, cleanTitle)

    title.textContent = cleanTitle
    videoTitle.textContent = cleanVideoTitle
    range.textContent = `${formatLibraryTime(clip.start)} - ${formatLibraryTime(clip.end)}`
    trigger.setAttribute("aria-label", t("openClipAria", [cleanTitle]))

    if (syncBadge) {
        syncBadge.hidden = !showSyncAlerts || isSynced
        syncBadge.addEventListener("click", (event) => {
            event.stopPropagation()
            actions.onOpen(clip)
        })
    }

    trigger.addEventListener("click", () => {
        actions.onOpen(clip)
    })

    deleteButton.addEventListener("click", (event) => {
        event.stopPropagation()
        if (confirm(t("deleteClipConfirm", [cleanTitle]))) {
            actions.onDelete(clip)
        }
    })

    return fragment
}

export function renderEmptyState(container: HTMLElement): void {
    container.appendChild(
        createElement("div", {
            className: "empty-state",
            textContent: t("emptyLibrary")
        })
    )
}

export function renderClipGrid(
    container: HTMLElement,
    template: HTMLTemplateElement,
    clips: Clip[],
    syncedIds: Set<string>,
    showSyncAlerts: boolean,
    actions: ClipCardActions
): void {
    container.replaceChildren()

    if (!clips.length) {
        renderEmptyState(container)
        return
    }

    clips.forEach((clip) => {
        const fragment = createClipCardElement(template, clip, syncedIds.has(clip.id), showSyncAlerts, actions)
        if (fragment) {
            container.appendChild(fragment)
        }
    })
}
