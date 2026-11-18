import cancelIcon from "../../icons/cancel.svg"
import scissorsIcon from "../../icons/scissors.svg"
import deleteIcon from "../../icons/delete.svg"
import editIcon from "../../icons/edit.svg"
import saveIcon from "../../icons/save.svg"
import { t } from "../i18n/index"
import { createElement } from "../utils/dom"
import { WAKE_CONTROLS_EVENT } from "../utils/events"
import { isAdShowing } from "../utils/youtube"
import { getClipsTopOffset } from "./timelineMath"

const CONTROLS_KEEP_ALIVE_INTERVAL_MS = 1500
const AUTOHIDE_WAKE_COOLDOWN_MS = 250

/**
 * Encapsulates player overlay DOM elements and controls lifecycle inside the YouTube player.
 */
export class PlayerOverlayView {
    readonly root: HTMLDivElement
    readonly videoClips: HTMLDivElement
    readonly button: HTMLButtonElement
    readonly editButton: HTMLButtonElement
    readonly deleteButton: HTMLButtonElement
    readonly rangeWrap: HTMLDivElement
    readonly rangeSelection: HTMLDivElement
    readonly pseudoTimeline: HTMLDivElement
    readonly pseudoTimelineProgress: HTMLDivElement
    readonly rangeConnector: HTMLDivElement
    readonly titleInput: HTMLInputElement
    readonly saveButton: HTMLButtonElement
    readonly cancelButton: HTMLButtonElement
    readonly toast: HTMLDivElement
    readonly timeDisplay: HTMLDivElement
    private readonly timeWrapper: HTMLDivElement
    readonly startTimeButton: HTMLButtonElement
    private readonly startTimeMain: HTMLSpanElement
    private readonly startTimeFrame: HTMLSpanElement
    readonly timeSeparator: HTMLSpanElement
    readonly endTimeButton: HTMLButtonElement
    private readonly endTimeMain: HTMLSpanElement
    private readonly endTimeFrame: HTMLSpanElement
    onLayoutUpdate: (() => void) | null = null
    onTitleEnter: (() => void) | null = null
    onTitleEscape: (() => void) | null = null

    private player: HTMLElement
    private toastTimeoutId: ReturnType<typeof setTimeout> | null = null
    private isControlsKeepAlive = false
    private keepAliveIntervalId: ReturnType<typeof setInterval> | null = null
    private lastWakeEventTime = 0
    private autohideObserver: MutationObserver | null = null
    private resizeObserver: ResizeObserver | null = null

    get playerElement(): HTMLElement {
        return this.player
    }

    constructor(player: HTMLElement) {
        this.player = player
        this.root = createElement("div", { id: "carpe-root" })
        this.videoClips = createElement("div", {
            id: "carpe-video-clips",
            role: "group",
            ariaLabel: t("overlayClipsGroupAria"),
            hidden: true
        })

        const controls = this.createControlButtons()
        this.button = controls.button
        this.editButton = controls.editButton
        this.deleteButton = controls.deleteButton

        const timeline = this.createTimelineOverlay()
        this.pseudoTimelineProgress = timeline.pseudoTimelineProgress
        this.pseudoTimeline = timeline.pseudoTimeline
        this.rangeConnector = timeline.rangeConnector
        this.rangeSelection = timeline.rangeSelection
        this.rangeWrap = timeline.rangeWrap

        this.titleInput = this.createTitleInput()

        const actions = this.createActionButtons()
        this.saveButton = actions.saveButton
        this.cancelButton = actions.cancelButton

        const time = this.createTimeDisplay()
        this.startTimeButton = time.startTimeButton
        this.startTimeMain = time.startTimeMain
        this.startTimeFrame = time.startTimeFrame
        this.timeSeparator = time.timeSeparator
        this.endTimeButton = time.endTimeButton
        this.endTimeMain = time.endTimeMain
        this.endTimeFrame = time.endTimeFrame
        this.timeWrapper = time.timeWrapper
        this.timeDisplay = time.timeDisplay

        this.toast = createElement("div", { id: "carpe-toast" })
        this.root.append(this.rangeWrap, this.toast)

        this.mount()

        this.resizeObserver = new ResizeObserver(() => {
            this.updateLayout()
        })
        this.resizeObserver.observe(this.player)
    }

    private createControlButtons(): {
        button: HTMLButtonElement
        editButton: HTMLButtonElement
        deleteButton: HTMLButtonElement
    } {
        const button = createElement("button", {
            id: "carpe-toggle",
            className: "ytp-button",
            type: "button",
            ariaLabel: t("createClipAria"),
            svgIcon: scissorsIcon
        })
        const editButton = createElement("button", {
            id: "carpe-edit-toggle",
            className: "ytp-button",
            type: "button",
            hidden: true,
            ariaLabel: t("editClipAria"),
            svgIcon: editIcon
        })
        const deleteButton = createElement("button", {
            id: "carpe-delete-toggle",
            className: "ytp-button",
            type: "button",
            hidden: true,
            ariaLabel: t("deleteClipAria"),
            svgIcon: deleteIcon
        })
        return { button, editButton, deleteButton }
    }

    private createTimelineOverlay(): {
        pseudoTimelineProgress: HTMLDivElement
        pseudoTimeline: HTMLDivElement
        rangeConnector: HTMLDivElement
        rangeSelection: HTMLDivElement
        rangeWrap: HTMLDivElement
    } {
        const pseudoTimelineProgress = createElement("div", {
            id: "carpe-pseudo-timeline-progress",
            ariaHidden: "true"
        })
        const pseudoTimeline = createElement("div", {
            id: "carpe-pseudo-timeline",
            ariaHidden: "true",
            children: [pseudoTimelineProgress]
        })
        const rangeConnector = createElement("div", {
            id: "carpe-range-connector",
            ariaHidden: "true"
        })
        const rangeSelection = createElement("div", {
            id: "carpe-range-selection",
            ariaHidden: "true",
            children: [pseudoTimeline, rangeConnector]
        })
        const rangeWrap = createElement("div", {
            id: "carpe-range-wrap",
            ariaHidden: "true",
            attributes: { dir: "ltr" },
            children: [rangeSelection]
        })
        return { pseudoTimelineProgress, pseudoTimeline, rangeConnector, rangeSelection, rangeWrap }
    }

    private createTitleInput(): HTMLInputElement {
        const titleInput = createElement("input", {
            id: "carpe-title",
            type: "text",
            hidden: true,
            ariaLabel: t("clipTitleInputAria"),
            attributes: {
                maxlength: "60",
                placeholder: t("clipTitlePlaceholder"),
                autocomplete: "off"
            }
        })

        const stopPlayerShortcut = (event: Event) => {
            if (event instanceof KeyboardEvent && event.type === "keydown") {
                if (!event.isComposing && event.keyCode !== 229) {
                    if (event.key === "Enter") {
                        event.preventDefault()
                        this.onTitleEnter?.()
                    } else if (event.key === "Escape") {
                        event.preventDefault()
                        this.onTitleEscape?.()
                    }
                }
            }
            event.stopPropagation()
            event.stopImmediatePropagation()
        }
        const inputEvents = ["keydown", "keyup", "pointerdown", "mousedown", "click"]
        for (const eventName of inputEvents) {
            titleInput.addEventListener(eventName, stopPlayerShortcut)
        }
        return titleInput
    }

    private createActionButtons(): {
        saveButton: HTMLButtonElement
        cancelButton: HTMLButtonElement
    } {
        const saveButton = createElement("button", {
            id: "carpe-save-button",
            className: "ytp-button",
            type: "button",
            hidden: true,
            ariaLabel: t("saveClipAria"),
            svgIcon: saveIcon
        })
        const cancelButton = createElement("button", {
            id: "carpe-cancel-button",
            className: "ytp-button",
            type: "button",
            hidden: true,
            ariaLabel: t("cancelClipAria"),
            svgIcon: cancelIcon
        })
        return { saveButton, cancelButton }
    }

    private createTimeDisplay(): {
        startTimeButton: HTMLButtonElement
        startTimeMain: HTMLSpanElement
        startTimeFrame: HTMLSpanElement
        timeSeparator: HTMLSpanElement
        endTimeButton: HTMLButtonElement
        endTimeMain: HTMLSpanElement
        endTimeFrame: HTMLSpanElement
        timeWrapper: HTMLDivElement
        timeDisplay: HTMLDivElement
    } {
        const startTimeMain = createElement("span", { textContent: "0:00" })
        const startTimeFrame = createElement("span", { className: "carpe-time-frame", textContent: ":00" })
        const startTimeLabel = createElement("span", { children: [startTimeMain, startTimeFrame] })
        const startTimeButton = createElement("button", {
            id: "carpe-time-start",
            className: "ytp-time-current carpe-time-button",
            type: "button",
            ariaLabel: t("startTimeAria"),
            ariaPressed: "false",
            children: [startTimeLabel]
        })
        const timeSeparator = createElement("span", {
            className: "ytp-time-separator carpe-time-separator",
            ariaHidden: "true",
            textContent: "-"
        })
        const endTimeMain = createElement("span", { textContent: "0:00" })
        const endTimeFrame = createElement("span", { className: "carpe-time-frame", textContent: ":00" })
        const endTimeLabel = createElement("span", { children: [endTimeMain, endTimeFrame] })
        const endTimeButton = createElement("button", {
            id: "carpe-time-end",
            className: "ytp-time-duration carpe-time-button",
            type: "button",
            ariaLabel: t("endTimeAria"),
            ariaPressed: "false",
            children: [endTimeLabel]
        })

        const timeContents = createElement("div", {
            className: "ytp-time-contents",
            children: [startTimeButton, timeSeparator, endTimeButton]
        })
        const timeWrapper = createElement("div", {
            className: "ytp-time-wrapper ytp-time-wrapper-delhi",
            children: [timeContents]
        })
        const timeDisplay = createElement("div", {
            id: "carpe-time-display",
            className: "ytp-time-display notranslate",
            hidden: true,
            attributes: { dir: "ltr" },
            children: [timeWrapper]
        })

        return {
            startTimeButton,
            startTimeMain,
            startTimeFrame,
            timeSeparator,
            endTimeButton,
            endTimeMain,
            endTimeFrame,
            timeWrapper,
            timeDisplay
        }
    }

    setAnchorTime(anchor: "start" | "end", time: string, frame: string): void {
        if (anchor === "start") {
            this.startTimeMain.textContent = time
            this.startTimeFrame.textContent = `:${frame}`
            return
        }
        this.endTimeMain.textContent = time
        this.endTimeFrame.textContent = `:${frame}`
    }

    get isMounted(): boolean {
        if (!this.player.isConnected) return false
        const chromeBottom = this.player.querySelector<HTMLElement>(".ytp-chrome-bottom")
        const leftControls = this.player.querySelector<HTMLElement>(".ytp-left-controls")
        const rightControls = this.player.querySelector<HTMLElement>(".ytp-right-controls")
        if (!chromeBottom || !rightControls) return false

        const rightMounted = [
            this.button,
            this.editButton,
            this.deleteButton,
            this.titleInput,
            this.saveButton,
            this.cancelButton
        ].every((control) => control.parentElement === rightControls)

        const leftMounted = Boolean(leftControls && this.timeDisplay.parentElement === leftControls)

        return (
            this.root.parentElement === chromeBottom &&
            this.videoClips.parentElement === chromeBottom &&
            rightMounted &&
            leftMounted
        )
    }

    updateLayout(): void {
        if (!this.player.isConnected) return
        const chromeBottom = this.player.querySelector<HTMLElement>(".ytp-chrome-bottom")
        const clipsHost = chromeBottom || this.player
        const playerTop = this.player.getBoundingClientRect().top
        const clipsHostTop = clipsHost.getBoundingClientRect().top
        const clipsTopOffset = getClipsTopOffset(this.player)
        this.videoClips.style.top = `${playerTop + clipsTopOffset - clipsHostTop}px`
        this.onLayoutUpdate?.()
    }

    showToast(message: string): void {
        this.toast.textContent = message
        this.toast.classList.add("visible")
        if (this.toastTimeoutId !== null) {
            clearTimeout(this.toastTimeoutId)
        }
        this.toastTimeoutId = setTimeout(() => {
            this.toast.classList.remove("visible")
            this.toastTimeoutId = null
        }, 2200)
    }

    private dispatchWakeControlsEvent(): void {
        this.lastWakeEventTime = performance.now()
        this.player.dispatchEvent(new CustomEvent(WAKE_CONTROLS_EVENT, { bubbles: true }))
    }

    wakeUpPlayerControls(): void {
        this.player.classList.remove("ytp-autohide")
        this.player.classList.add("carpe-focused")
        this.dispatchWakeControlsEvent()
    }

    startControlsKeepAlive(): void {
        this.isControlsKeepAlive = true
        this.wakeUpPlayerControls()

        if (this.keepAliveIntervalId === null) {
            this.keepAliveIntervalId = setInterval(() => {
                if (!this.isControlsKeepAlive || !this.player.isConnected) return
                this.wakeUpPlayerControls()
            }, CONTROLS_KEEP_ALIVE_INTERVAL_MS)
        }

        if (!this.autohideObserver) {
            this.autohideObserver = new MutationObserver(() => {
                if (this.isControlsKeepAlive && this.player.classList.contains("ytp-autohide")) {
                    this.player.classList.remove("ytp-autohide")
                    if (performance.now() - this.lastWakeEventTime >= AUTOHIDE_WAKE_COOLDOWN_MS) {
                        this.dispatchWakeControlsEvent()
                    }
                }
            })
            this.autohideObserver.observe(this.player, {
                attributes: true,
                attributeFilter: ["class"]
            })
        }
    }

    stopControlsKeepAlive(): void {
        this.isControlsKeepAlive = false
        if (this.keepAliveIntervalId !== null) {
            clearInterval(this.keepAliveIntervalId)
            this.keepAliveIntervalId = null
        }
        if (this.autohideObserver) {
            this.autohideObserver.disconnect()
            this.autohideObserver = null
        }
        this.player.classList.remove("carpe-focused")
    }

    mount(): void {
        if (!this.player.isConnected) {
            return
        }

        const adShowing = isAdShowing(this.player)
        this.button.style.display = adShowing ? "none" : ""
        if (adShowing) {
            this.videoClips.hidden = true
        }

        const chromeBottom = this.player.querySelector<HTMLElement>(".ytp-chrome-bottom")
        if (chromeBottom) {
            if (this.root.parentElement !== chromeBottom) {
                chromeBottom.appendChild(this.root)
            }
            if (this.videoClips.parentElement !== chromeBottom) {
                chromeBottom.appendChild(this.videoClips)
            }
            this.updateLayout()
        }

        const leftControls = this.player.querySelector<HTMLElement>(".ytp-left-controls")
        if (leftControls) {
            const nativeTimeDisplay = leftControls.querySelector<HTMLElement>(
                ".ytp-time-display:not(#carpe-time-display)"
            )
            const nativeTimeWrapper = nativeTimeDisplay?.querySelector<HTMLElement>(".ytp-time-wrapper")
            if (nativeTimeWrapper?.className && this.timeWrapper.className !== nativeTimeWrapper.className) {
                this.timeWrapper.className = nativeTimeWrapper.className
            }
            if (this.timeDisplay.parentElement !== leftControls) {
                if (nativeTimeDisplay && nativeTimeDisplay.nextSibling) {
                    leftControls.insertBefore(this.timeDisplay, nativeTimeDisplay.nextSibling)
                } else {
                    leftControls.appendChild(this.timeDisplay)
                }
            }
        }

        const rightControls = this.player.querySelector<HTMLElement>(".ytp-right-controls")
        if (rightControls) {
            const controls: HTMLElement[] = [
                this.button,
                this.editButton,
                this.deleteButton,
                this.titleInput,
                this.saveButton,
                this.cancelButton
            ]
            const alreadyMounted = controls.every((control, index) => rightControls.children[index] === control)

            if (!alreadyMounted) {
                const firstNativeButton =
                    Array.from(rightControls.children).find((child) => !controls.includes(child as HTMLElement)) || null
                controls.forEach((control) => rightControls.insertBefore(control, firstNativeButton))
            }
        }
    }

    destroy(): void {
        this.onLayoutUpdate = null
        this.onTitleEnter = null
        this.onTitleEscape = null
        this.player.classList.remove("carpe-selecting")
        if (this.toastTimeoutId !== null) {
            clearTimeout(this.toastTimeoutId)
            this.toastTimeoutId = null
        }
        this.resizeObserver?.disconnect()
        this.resizeObserver = null
        this.stopControlsKeepAlive()
        this.root.remove()
        this.videoClips.remove()
        this.timeDisplay.remove()
        this.button.remove()
        this.editButton.remove()
        this.deleteButton.remove()
        this.titleInput.remove()
        this.saveButton.remove()
        this.cancelButton.remove()
    }
}
