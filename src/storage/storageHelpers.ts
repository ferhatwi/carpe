export { createTaskQueue } from "../utils/async"

/**
 * Checks if chrome.storage.sync is available in the current environment.
 */
export function isSyncAvailable(): boolean {
    return typeof chrome !== "undefined" && Boolean(chrome.storage.sync)
}

/**
 * Safely reads a key-value record from chrome.storage (local or sync),
 * ensuring the returned value is a non-array object.
 */
export async function readStorageRecord<T = unknown>(
    key: string,
    area: "local" | "sync" = "local"
): Promise<Record<string, T>> {
    const storageArea = area === "sync" ? chrome.storage.sync : chrome.storage.local
    if (!storageArea) return {}

    const res = await storageArea.get(key)
    const val = res?.[key]
    if (val && typeof val === "object" && !Array.isArray(val)) {
        return val as Record<string, T>
    }
    return {}
}
