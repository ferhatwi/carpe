import { WAKE_CONTROLS_EVENT } from "./utils/events"

// YouTube exposes wakeUpControls() on the page-world player element;
// called from MAIN world since content scripts run in an isolated world.
type YouTubePlayerElement = HTMLElement & {
    wakeUpControls?: () => void
}

document.addEventListener(WAKE_CONTROLS_EVENT, (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    const player =
        target?.closest<YouTubePlayerElement>(".html5-video-player, #movie_player") ||
        document.querySelector<YouTubePlayerElement>(".html5-video-player, #movie_player")

    player?.wakeUpControls?.()
})
