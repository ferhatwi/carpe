import { setPendingPlayback } from "../src/storage/index"
import { Clip } from "../src/types"

/**
 * Focuses an existing YouTube watch tab for the given clip or opens a new tab,
 * triggering playback via content script RPC or pending playback fallback.
 */
export async function openClipInYouTube(clip: Clip): Promise<void> {
    const start = Math.max(0, Math.floor(Number(clip.start) || 0))
    const targetWatchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(clip.videoId)}&t=${start}s`

    const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/watch*", "https://youtube.com/watch*"] })
    const existingTab = tabs.find((tab) => {
        if (!tab.url) return false
        try {
            const url = new URL(tab.url)
            return url.searchParams.get("v") === clip.videoId
        } catch {
            return false
        }
    })

    if (existingTab?.id !== undefined) {
        await chrome.tabs.update(existingTab.id, { active: true })
        if (existingTab.windowId !== undefined) {
            await chrome.windows.update(existingTab.windowId, { focused: true })
        }

        try {
            const response = await chrome.tabs.sendMessage<
                { action: string; clipId: string; videoId: string },
                { ok?: boolean }
            >(existingTab.id, {
                action: "playClip",
                clipId: clip.id,
                videoId: clip.videoId
            })
            if (response?.ok) {
                return
            }
        } catch {
            // Tab predates extension load, is discarded, or has no active content script
        }

        await setPendingPlayback({ clipId: clip.id, videoId: clip.videoId, tabId: existingTab.id })
        await chrome.tabs.update(existingTab.id, { url: targetWatchUrl, active: true })
        return
    }

    const createdTab = await chrome.tabs.create({ url: targetWatchUrl, active: true })
    if (createdTab.id !== undefined) {
        await setPendingPlayback({ clipId: clip.id, videoId: clip.videoId, tabId: createdTab.id })
        return
    }
    await setPendingPlayback({ clipId: clip.id, videoId: clip.videoId })
}
