import { isAdShowing } from "../utils/youtube"

const MEDIA_READY_EVENTS = ["canplay", "loadeddata", "durationchange", "playing"] as const

/**
 * Checks whether the player is currently free of ads and the video element has loaded frames.
 */
export function isPlayerMediaReady(player: HTMLElement, video: HTMLVideoElement): boolean {
    return (
        !isAdShowing(player) &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        Number.isFinite(video.duration) &&
        video.duration > 0
    )
}

/**
 * Observes DOM mutations on the player and ad module, as well as media readiness events,
 * calling onReady when the player is unblocked by ads and has valid media data.
 */
export class PlayerReadinessWatcher {
    private readonly player: HTMLElement
    private readonly video: HTMLVideoElement
    private readonly onReady: () => void
    private playerObserver: MutationObserver | null = null
    private adModuleObserver: MutationObserver | null = null
    private observedAdModule: Element | null = null
    private isWatching = false

    constructor(player: HTMLElement, video: HTMLVideoElement, onReady: () => void) {
        this.player = player
        this.video = video
        this.onReady = onReady
    }

    get isReady(): boolean {
        return isPlayerMediaReady(this.player, this.video)
    }

    start(): void {
        this.stop()
        this.isWatching = true

        if (this.isReady) {
            this.onReady()
            return
        }

        this.playerObserver = new MutationObserver(() => {
            this.syncAdModuleObserver()
            this.check()
        })
        this.playerObserver.observe(this.player, {
            attributes: true,
            attributeFilter: ["class"],
            childList: true
        })
        this.syncAdModuleObserver()

        for (const event of MEDIA_READY_EVENTS) {
            this.video.addEventListener(event, this.check)
        }
    }

    stop(): void {
        this.isWatching = false
        for (const event of MEDIA_READY_EVENTS) {
            this.video.removeEventListener(event, this.check)
        }
        if (this.playerObserver) {
            this.playerObserver.disconnect()
            this.playerObserver = null
        }
        if (this.adModuleObserver) {
            this.adModuleObserver.disconnect()
            this.adModuleObserver = null
        }
        this.observedAdModule = null
    }

    private check = (): void => {
        if (this.isWatching && this.isReady) {
            this.onReady()
        }
    }

    private syncAdModuleObserver(): void {
        const adModule = this.player.querySelector(".video-ads.ytp-ad-module")
        if (adModule === this.observedAdModule) {
            return
        }
        if (this.adModuleObserver) {
            this.adModuleObserver.disconnect()
            this.adModuleObserver = null
            this.observedAdModule = null
        }
        if (adModule) {
            this.adModuleObserver = new MutationObserver(this.check)
            this.adModuleObserver.observe(adModule, {
                childList: true,
                subtree: true
            })
            this.observedAdModule = adModule
        }
    }

    dispose(): void {
        this.stop()
    }
}
