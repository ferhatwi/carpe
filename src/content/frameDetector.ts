import { DEFAULT_FRAME_DURATION, snapFrameDuration } from "./timelineMath"

export interface VideoFrameRateDetectorOptions {
    shouldSample?: () => boolean
    onDetected?: () => void
}

/**
 * Samples HTMLVideoElement frame presentation times via requestVideoFrameCallback
 * to accurately detect and snap video stream frame rate (e.g. 24, 30, 60 fps).
 */
export class VideoFrameRateDetector {
    private readonly video: HTMLVideoElement
    private readonly shouldSample?: () => boolean
    private readonly onDetected?: () => void
    private detectedFrameDuration: number | null = null
    private bestFrameDuration: number | null = null
    private frameSampleCount = 0
    private lastMediaTime: number | null = null
    private frameCallbackHandle: number | null = null
    private isActive = false

    constructor(video: HTMLVideoElement, options: VideoFrameRateDetectorOptions = {}) {
        this.video = video
        this.shouldSample = options.shouldSample
        this.onDetected = options.onDetected
    }

    get frameDuration(): number {
        return this.detectedFrameDuration ?? DEFAULT_FRAME_DURATION
    }

    get isDetected(): boolean {
        return this.detectedFrameDuration !== null
    }

    start(): void {
        this.isActive = true
        if (this.detectedFrameDuration !== null) return
        this.scheduleFrame()
    }

    stop(): void {
        this.isActive = false
        this.cancelCallback()
        this.bestFrameDuration = null
        this.frameSampleCount = 0
        this.lastMediaTime = null
    }

    reset(): void {
        const wasActive = this.isActive
        this.detectedFrameDuration = null
        this.stop()
        if (wasActive) {
            this.start()
        }
    }

    private scheduleFrame(): void {
        if (
            !this.isActive ||
            this.frameCallbackHandle !== null ||
            typeof this.video.requestVideoFrameCallback !== "function"
        ) {
            return
        }

        const onFrame = (_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => {
            this.frameCallbackHandle = null
            if (!this.isActive) return

            if (this.shouldSample && !this.shouldSample()) {
                this.lastMediaTime = null
                if (this.isActive && typeof this.video.requestVideoFrameCallback === "function") {
                    this.frameCallbackHandle = this.video.requestVideoFrameCallback(onFrame)
                }
                return
            }

            if (this.lastMediaTime !== null) {
                // metadata.mediaTime is already in media-timeline seconds regardless of playbackRate
                const mediaDelta = Math.abs(metadata.mediaTime - this.lastMediaTime)
                if (mediaDelta >= 0.012 && mediaDelta <= 0.055) {
                    const snapped = snapFrameDuration(1 / mediaDelta)
                    if (snapped !== null) {
                        this.bestFrameDuration =
                            this.bestFrameDuration === null ? snapped : Math.min(this.bestFrameDuration, snapped)
                        this.frameSampleCount++
                        if (this.frameSampleCount >= 4) {
                            this.detectedFrameDuration = this.bestFrameDuration
                            this.lastMediaTime = null
                            this.onDetected?.()
                            return
                        }
                    }
                }
            }

            this.lastMediaTime = metadata.mediaTime
            if (this.isActive && typeof this.video.requestVideoFrameCallback === "function") {
                this.frameCallbackHandle = this.video.requestVideoFrameCallback(onFrame)
            }
        }

        this.frameCallbackHandle = this.video.requestVideoFrameCallback(onFrame)
    }

    private cancelCallback(): void {
        if (this.frameCallbackHandle !== null && typeof this.video.cancelVideoFrameCallback === "function") {
            this.video.cancelVideoFrameCallback(this.frameCallbackHandle)
            this.frameCallbackHandle = null
        }
    }

    dispose(): void {
        this.stop()
        this.detectedFrameDuration = null
    }
}
