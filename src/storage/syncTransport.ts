import type { Clip } from "../types"
import { isSyncAvailable } from "./storageHelpers"

export type ImportMode = "merge" | "replace"

export type SyncRpcRequest =
    | { action: "carpe:sync"; op: "upsert"; clip: Clip }
    | { action: "carpe:sync"; op: "delete"; id: string }
    | { action: "carpe:sync"; op: "reconcile" }
    | { action: "carpe:sync"; op: "archive"; keepCount: number }
    | { action: "carpe:sync"; op: "import"; importedIds: string[]; removedIds: string[]; mode: ImportMode }

export type SyncRpcResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string }

export function isSyncRpcRequest(msg: unknown): msg is SyncRpcRequest {
    if (!msg || typeof msg !== "object") return false
    const req = msg as Record<string, unknown>
    if (req.action !== "carpe:sync" || typeof req.op !== "string") return false
    switch (req.op) {
        case "upsert":
            return Boolean(req.clip && typeof req.clip === "object")
        case "delete":
            return typeof req.id === "string"
        case "reconcile":
            return true
        case "archive":
            return typeof req.keepCount === "number"
        case "import":
            return (
                Array.isArray(req.importedIds) &&
                Array.isArray(req.removedIds) &&
                (req.mode === "merge" || req.mode === "replace")
            )
        default:
            return false
    }
}

const OWN_MUTATION_TTL_MS = 2000

let syncHostRegistered = false
const pendingOwnSyncMutations = new Map<string, { count: number; expiresAt: number }>()

function jsonValuesEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true
    if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
        return a.every((item, idx) => jsonValuesEqual(item, b[idx]))
    }
    const objA = a as Record<string, unknown>
    const objB = b as Record<string, unknown>
    const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined)
    const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined)
    if (keysA.length !== keysB.length) return false
    return keysA.every((k) => k in objB && jsonValuesEqual(objA[k], objB[k]))
}

/**
 * Marks the current JS runtime as the single authoritative background sync coordinator.
 */
export function registerAsSyncHost(): void {
    syncHostRegistered = true
}

export async function sendSyncRequest<T>(request: SyncRpcRequest): Promise<T> {
    const response = (await chrome.runtime.sendMessage(request)) as SyncRpcResponse<T> | undefined
    if (!response) {
        throw new Error("No response from background sync service worker")
    }
    if (!response.ok) {
        throw new Error(response.error || "Background sync failed")
    }
    return response.data
}

/**
 * Records cloud keys about to be written/removed by the service worker so its
 * chrome.storage.onChanged listener ignores its own local browser echo.
 */
export function noteOwnSyncMutations(keys: Iterable<string>): void {
    if (!syncHostRegistered) return
    const now = Date.now()
    for (const [k, v] of pendingOwnSyncMutations.entries()) {
        if (now > v.expiresAt || v.count <= 0) {
            pendingOwnSyncMutations.delete(k)
        }
    }
    for (const key of keys) {
        const existing = pendingOwnSyncMutations.get(key)
        pendingOwnSyncMutations.set(key, {
            count: (existing ? existing.count : 0) + 1,
            expiresAt: now + OWN_MUTATION_TTL_MS
        })
    }
}

/**
 * Rolls back expected mutation counts if chrome.storage.sync.set/remove throws before committing.
 */
export function rollbackOwnSyncMutations(keys: Iterable<string>): void {
    if (!syncHostRegistered) return
    for (const key of keys) {
        const existing = pendingOwnSyncMutations.get(key)
        if (!existing) continue
        existing.count--
        if (existing.count <= 0) pendingOwnSyncMutations.delete(key)
    }
}

export async function syncSetWithTracking(payload: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(payload)
    if (keys.length === 0) return

    let changedKeys = keys
    if (syncHostRegistered && isSyncAvailable()) {
        try {
            const current = await chrome.storage.sync.get(keys)
            changedKeys = keys.filter((key) => !jsonValuesEqual(current?.[key], payload[key]))
        } catch {
            changedKeys = keys
        }
    }

    noteOwnSyncMutations(changedKeys)
    try {
        await chrome.storage.sync.set(payload)
    } catch (err) {
        rollbackOwnSyncMutations(changedKeys)
        throw err
    }
}

export async function syncRemoveWithTracking(keys: string[]): Promise<void> {
    if (keys.length === 0) return

    let existingKeys = keys
    if (syncHostRegistered && isSyncAvailable()) {
        try {
            const current = await chrome.storage.sync.get(keys)
            existingKeys = keys.filter((key) => current && key in current)
        } catch {
            existingKeys = keys
        }
    }

    noteOwnSyncMutations(existingKeys)
    try {
        await chrome.storage.sync.remove(keys)
    } catch (err) {
        rollbackOwnSyncMutations(existingKeys)
        throw err
    }
}

/**
 * Consumes one expected local sync mutation record when chrome.storage.onChanged fires.
 * Returns true if this key change matches an in-flight/recent service worker write.
 */
export function consumeOwnSyncMutation(key: string): boolean {
    const entry = pendingOwnSyncMutations.get(key)
    if (!entry) return false
    if (Date.now() > entry.expiresAt) {
        pendingOwnSyncMutations.delete(key)
        return false
    }
    entry.count--
    if (entry.count <= 0) pendingOwnSyncMutations.delete(key)
    return true
}
