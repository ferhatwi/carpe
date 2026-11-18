import { isExtensionContextValid } from "../utils/extension"
import { getPlayer, getVideoId } from "../utils/youtube"

export interface WatchPageObserverCallbacks {
    onSyncSession: () => void
    onAdStateChange: () => void
    onLayoutChange: () => void
    onInvalidated: () => void
    isSessionCurrentAndMounted: (currentVideoId: string | null) => boolean
    isSessionMounted: () => boolean
    mountSession: () => void
}

/**
 * Monitors YouTube watch page mutations, player element attachments, ad changes,
 * and navigation events (yt-navigate-finish, popstate, resize, fullscreen).
 */
export class WatchPageObserver {
    private readonly callbacks: WatchPageObserverCallbacks
    private playerObserver: MutationObserver | null = null
    private adModuleObserver: MutationObserver | null = null
    private bodyObserver: MutationObserver | null = null
    private observedPlayer: HTMLElement | null = null
    private observedAdModule: Element | null = null
    private syncRafId: number | null = null
    private isDisposed = false

    constructor(callbacks: WatchPageObserverCallbacks) {
        this.callbacks = callbacks
        this.start()
    }

    private syncAdModuleObserver(player: HTMLElement): void {
        const adModule = player.querySelector(".video-ads.ytp-ad-module")
        if (adModule === this.observedAdModule) return
        this.adModuleObserver?.disconnect()
        this.adModuleObserver = null
        this.observedAdModule = adModule
        if (adModule) {
            this.adModuleObserver = new MutationObserver(() => {
                if (!isExtensionContextValid()) {
                    this.callbacks.onInvalidated()
                    return
                }
                this.callbacks.onAdStateChange()
            })
            this.adModuleObserver.observe(adModule, {
                childList: true,
                subtree: true
            })
        }
    }

    private hookPlayerObserver(): void {
        if (!isExtensionContextValid()) {
            this.callbacks.onInvalidated()
            return
        }
        const player = getPlayer()
        if (player && player !== this.observedPlayer) {
            this.playerObserver?.disconnect()
            this.adModuleObserver?.disconnect()
            this.adModuleObserver = null
            this.observedAdModule = null
            this.observedPlayer = player
            this.playerObserver = new MutationObserver(() => {
                if (!isExtensionContextValid()) {
                    this.callbacks.onInvalidated()
                    return
                }
                this.syncAdModuleObserver(player)
                this.callbacks.onAdStateChange()
                if (!this.callbacks.isSessionMounted()) {
                    this.callbacks.mountSession()
                }
            })
            this.playerObserver.observe(player, {
                attributes: true,
                attributeFilter: ["class"],
                childList: true
            })
            this.syncAdModuleObserver(player)
        } else if (this.observedPlayer) {
            this.syncAdModuleObserver(this.observedPlayer)
        }
    }

    private scheduleSync(): void {
        if (this.syncRafId !== null) return
        this.syncRafId = requestAnimationFrame(() => {
            this.syncRafId = null
            this.callbacks.onSyncSession()
            this.hookPlayerObserver()
        })
    }

    private onNavigate = (): void => {
        this.callbacks.onSyncSession()
        this.hookPlayerObserver()
    }

    private onViewportOrFullscreenChange = (): void => {
        if (!isExtensionContextValid()) {
            this.callbacks.onInvalidated()
            return
        }
        this.callbacks.onLayoutChange()
    }

    start(): void {
        if (!isExtensionContextValid() || this.isDisposed) return

        this.bodyObserver = new MutationObserver(() => {
            if (!isExtensionContextValid()) {
                this.callbacks.onInvalidated()
                return
            }
            const currentVideoId = getVideoId()
            if (this.callbacks.isSessionCurrentAndMounted(currentVideoId)) {
                return
            }
            this.scheduleSync()
        })

        this.bodyObserver.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        })

        document.addEventListener("yt-navigate-finish", this.onNavigate)
        window.addEventListener("popstate", this.onNavigate)
        document.addEventListener("fullscreenchange", this.onViewportOrFullscreenChange)
        window.addEventListener("resize", this.onViewportOrFullscreenChange)

        this.hookPlayerObserver()
    }

    dispose(): void {
        this.isDisposed = true
        if (this.syncRafId !== null) {
            cancelAnimationFrame(this.syncRafId)
            this.syncRafId = null
        }
        this.bodyObserver?.disconnect()
        this.bodyObserver = null
        this.playerObserver?.disconnect()
        this.playerObserver = null
        this.adModuleObserver?.disconnect()
        this.adModuleObserver = null
        this.observedPlayer = null
        this.observedAdModule = null
        document.removeEventListener("yt-navigate-finish", this.onNavigate)
        window.removeEventListener("popstate", this.onNavigate)
        document.removeEventListener("fullscreenchange", this.onViewportOrFullscreenChange)
        window.removeEventListener("resize", this.onViewportOrFullscreenChange)
    }
}
