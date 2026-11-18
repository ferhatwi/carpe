import { PlayerOverlayView } from "./content/playerOverlayView"
import { VideoSession } from "./content/videoSession"
import { WatchPageObserver } from "./content/watchPageObserver"
import { isExtensionContextValid } from "./utils/extension"
import { resolveWatchContext } from "./utils/youtube"

let activeSession: VideoSession | null = null
let watchObserver: WatchPageObserver | null = null

function teardownAll(): void {
    watchObserver?.dispose()
    watchObserver = null
    activeSession?.dispose()
    activeSession = null
}

function syncSession(): void {
    if (!isExtensionContextValid()) {
        teardownAll()
        return
    }

    const ctx = resolveWatchContext()

    // 1. Navigating away from a watch page
    if (!ctx) {
        if (activeSession) {
            activeSession.dispose()
            activeSession = null
        }
        return
    }

    // 2. Same video and player element: ensure UI is mounted and exit
    if (
        activeSession &&
        activeSession.videoId === ctx.videoId &&
        activeSession.video === ctx.video &&
        activeSession.view.playerElement === ctx.player
    ) {
        if (!activeSession.isMounted) {
            activeSession.mount()
        }
        return
    }

    // 3. Video or player changed: dispose previous session and create a scoped replacement
    activeSession?.dispose()
    const view = new PlayerOverlayView(ctx.player)
    activeSession = new VideoSession(ctx.videoId, ctx.video, view, teardownAll)
}

function initWatchObserver(): void {
    if (!isExtensionContextValid() || watchObserver) return

    watchObserver = new WatchPageObserver({
        onSyncSession: () => syncSession(),
        onAdStateChange: () => activeSession?.syncAdState(),
        onLayoutChange: () => activeSession?.view.updateLayout(),
        onInvalidated: () => teardownAll(),
        isSessionCurrentAndMounted: (currentVideoId) =>
            Boolean(
                activeSession &&
                activeSession.videoId === currentVideoId &&
                activeSession.isMounted &&
                activeSession.view.playerElement.isConnected &&
                activeSession.video.isConnected
            ),
        isSessionMounted: () => Boolean(activeSession?.isMounted),
        mountSession: () => activeSession?.mount()
    })
}

if (isExtensionContextValid()) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!isExtensionContextValid()) {
            teardownAll()
            return
        }
        if (
            message?.action === "playClip" &&
            typeof message.clipId === "string" &&
            typeof message.videoId === "string"
        ) {
            if (!activeSession || activeSession.videoId !== message.videoId) {
                sendResponse({ ok: false })
                return
            }
            void activeSession
                .playClipById(message.clipId)
                .then((ok) => sendResponse({ ok }))
                .catch(() => sendResponse({ ok: false }))
            return true
        }
    })
}

function main(): void {
    initWatchObserver()
    syncSession()
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main)
} else {
    main()
}
