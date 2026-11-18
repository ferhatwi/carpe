export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
}

function formatSeconds(seconds: number, padLeading: boolean): string {
    const wholeSeconds = Math.max(0, Math.floor(Number(seconds) || 0))
    const hours = Math.floor(wholeSeconds / 3600)
    const minutes = Math.floor((wholeSeconds % 3600) / 60)
    const secs = wholeSeconds % 60
    const formatLeading = (value: number) => (padLeading ? String(value).padStart(2, "0") : String(value))

    if (hours > 0) {
        return `${formatLeading(hours)}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    }

    return `${formatLeading(minutes)}:${String(secs).padStart(2, "0")}`
}

export interface FormattedFrameTime {
    time: string
    frame: string
}

export function formatClipTime(seconds: number): string {
    return formatSeconds(seconds, false)
}

export function formatClipTimeWithFrame(seconds: number, frameDuration: number): FormattedFrameTime {
    const safeSeconds = Math.max(0, Number(seconds) || 0)
    const fps = frameDuration > 0 && Number.isFinite(frameDuration) ? Math.max(1, Math.round(1 / frameDuration)) : 30
    const totalFrames = Math.round(safeSeconds * fps)
    const wholeSeconds = Math.floor(totalFrames / fps)
    const frameIndex = totalFrames % fps

    return {
        time: formatSeconds(wholeSeconds, false),
        frame: String(frameIndex).padStart(2, "0")
    }
}

export function formatLibraryTime(seconds: number): string {
    return formatSeconds(seconds, true)
}
