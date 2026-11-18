import { clearPendingPlaybackForTab, consumePendingPlayback, setPendingPlayback } from "./storage/pendingPlayback"
import { runStorageMigrations } from "./storage/migrations"
import {
    archiveOldSyncClips,
    isSyncPassRunning,
    pullAndMergeSyncClips,
    syncDeleteClip,
    syncImportedClips,
    syncUpsertClip
} from "./storage/syncEngine"
import { reconcileRetryAlarm, SYNC_RETRY_ALARM } from "./storage/syncRetryAlarm"
import {
    consumeOwnSyncMutation,
    isSyncRpcRequest,
    registerAsSyncHost,
    type SyncRpcRequest
} from "./storage/syncTransport"
import {
    type PendingPlayback,
    SYNC_CONFIG_KEY,
    SYNC_PREFIX,
    SYNC_SETTINGS_KEY,
    SYNC_STATUS_KEY,
    SYNC_TOMBSTONES_KEY
} from "./types"

registerAsSyncHost()

let activeSyncReconcileCount = 0
let pendingExternalSyncFollowup = false
let migrationsReadyPromise: Promise<void> | null = null

function ensureMigrationsReady(): Promise<void> {
    if (!migrationsReadyPromise) {
        migrationsReadyPromise = runStorageMigrations().catch((err) => {
            migrationsReadyPromise = null
            throw err
        })
    }
    return migrationsReadyPromise
}

async function runSyncAndReconcile(): Promise<void> {
    await ensureMigrationsReady()
    activeSyncReconcileCount++
    try {
        do {
            pendingExternalSyncFollowup = false
            await pullAndMergeSyncClips()
        } while (pendingExternalSyncFollowup)
    } finally {
        activeSyncReconcileCount--
    }
    await reconcileRetryAlarm()
}

async function handleSyncRpc(request: SyncRpcRequest): Promise<unknown> {
    await ensureMigrationsReady()
    activeSyncReconcileCount++
    try {
        let result: unknown
        switch (request.op) {
            case "upsert":
                result = await syncUpsertClip(request.clip)
                break
            case "delete":
                result = await syncDeleteClip(request.id)
                break
            case "reconcile":
                result = await pullAndMergeSyncClips()
                break
            case "archive":
                result = await archiveOldSyncClips(request.keepCount)
                break
            case "import":
                result = await syncImportedClips(request.importedIds, request.removedIds, request.mode)
                break
        }
        while (pendingExternalSyncFollowup) {
            pendingExternalSyncFollowup = false
            await pullAndMergeSyncClips()
        }
        return result
    } finally {
        activeSyncReconcileCount--
    }
}

chrome.runtime.onInstalled.addListener(() => {
    void runSyncAndReconcile().catch((err) => console.error("[Carpe ServiceWorker] Init error:", err))
})

chrome.runtime.onStartup.addListener(() => {
    void runSyncAndReconcile().catch((err) => console.error("[Carpe ServiceWorker] Startup sync error:", err))
})

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SYNC_RETRY_ALARM) return
    void runSyncAndReconcile().catch((err) => console.error("[Carpe ServiceWorker] Retry sync error:", err))
})

chrome.tabs?.onRemoved?.addListener((tabId) => {
    void clearPendingPlaybackForTab(tabId).catch((err) => {
        console.warn("[Carpe ServiceWorker] Failed to clear pending playback for tab:", err)
    })
})

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync") {
        let hasExternalChange = false
        for (const key of Object.keys(changes)) {
            const isRelevant = key === SYNC_TOMBSTONES_KEY || key === SYNC_CONFIG_KEY || key.startsWith(SYNC_PREFIX)
            if (!consumeOwnSyncMutation(key) && isRelevant) {
                hasExternalChange = true
            }
        }
        if (!hasExternalChange) return
        if (isSyncPassRunning()) {
            pendingExternalSyncFollowup = true
            return
        }
        void runSyncAndReconcile().catch((err) => console.error("[Carpe ServiceWorker] Sync pull error:", err))
        return
    }

    if (
        areaName === "local" &&
        activeSyncReconcileCount === 0 &&
        (changes[SYNC_STATUS_KEY] || changes[SYNC_SETTINGS_KEY])
    ) {
        void reconcileRetryAlarm().catch((err) => console.error("[Carpe ServiceWorker] Alarm reconcile error:", err))
    }
})

chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({
        url: chrome.runtime.getURL("library/index.html")
    })
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action === "openVault") {
        const url = message?.reason
            ? chrome.runtime.getURL(`library/index.html?reason=${encodeURIComponent(message.reason)}`)
            : chrome.runtime.getURL("library/index.html")
        chrome.tabs.create({ url, active: true })
        sendResponse({ ok: true })
        return
    }

    if (
        message?.action === "carpe:setPendingPlayback" &&
        message.playback &&
        typeof message.playback === "object" &&
        typeof message.playback.clipId === "string" &&
        typeof message.playback.videoId === "string"
    ) {
        void setPendingPlayback(message.playback as PendingPlayback)
            .then(() => sendResponse({ ok: true }))
            .catch(() => sendResponse({ ok: false }))
        return true
    }

    if (message?.action === "carpe:consumePendingPlayback" && typeof message.videoId === "string") {
        void consumePendingPlayback(message.videoId, sender.tab?.id)
            .then((playback) => sendResponse({ ok: true, playback }))
            .catch(() => sendResponse({ ok: true, playback: null }))
        return true
    }

    if (isSyncRpcRequest(message)) {
        void handleSyncRpc(message)
            .then(async (data) => {
                await reconcileRetryAlarm().catch((err) => {
                    console.warn("[Carpe ServiceWorker] Alarm reconcile failed:", err)
                })
                sendResponse({ ok: true, data })
            })
            .catch((err) => {
                sendResponse({
                    ok: false,
                    error: err instanceof Error ? err.message : String(err || "Sync error")
                })
            })
        return true
    }
})
