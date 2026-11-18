/**
 * Returns true while the extension runtime context is still active
 * (becomes false in stale content scripts after extension reload/update).
 */
export function isExtensionContextValid(): boolean {
    try {
        return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id)
    } catch {
        return false
    }
}

/**
 * Returns true when an error was caused by extension context invalidation.
 */
export function isContextInvalidatedError(err: unknown): boolean {
    if (!isExtensionContextValid()) {
        return true
    }
    const message = err instanceof Error ? err.message : String(err || "")
    return /Extension context invalidated/i.test(message)
}

/**
 * Returns true if running in a windowed foreground environment (content script, popup, or options page),
 * as opposed to a headless background Service Worker.
 */
export function isForegroundContext(): boolean {
    return typeof window !== "undefined"
}

/**
 * Returns true if the extension messaging API is available to send messages to the background worker.
 */
export function canSendRuntimeMessage(): boolean {
    return (
        typeof chrome !== "undefined" &&
        Boolean(chrome.runtime?.id) &&
        typeof chrome.runtime?.sendMessage === "function"
    )
}
