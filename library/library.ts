import { initPageI18n } from "../src/i18n/index"
import {
    deleteClip,
    getSyncedClipIds,
    getSyncSettings,
    getSyncStatus,
    hasLocalClipChange,
    hasSyncClipChange,
    readClips,
    requestSyncReconcile
} from "../src/storage/index"
import { Clip, SYNC_SETTINGS_KEY, SYNC_STATUS_KEY } from "../src/types"
import { renderClipGrid } from "./clipCard"
import { mountAppShell } from "./common"
import { openClipInYouTube } from "./navigation"

// Clips View Elements
const clipGrid = document.querySelector<HTMLElement>("#clip-grid")
const template = document.querySelector<HTMLTemplateElement>("#clip-card-template")
const syncBanner = document.querySelector<HTMLElement>("#sync-banner")
const bannerDismissBtn = document.querySelector<HTMLButtonElement>("#banner-dismiss-btn")

let currentClips: Clip[] = []
let currentSyncedIds = new Set<string>()
let currentSyncEnabled = true
let bannerDismissed = false
let refreshSeq = 0
let syncUiSeq = 0

// Initialize i18n and shared app shell
initPageI18n("libraryPageTitle")
mountAppShell("clips")

async function refreshSyncUI(): Promise<void> {
    const seq = ++syncUiSeq
    const [status, settings] = await Promise.all([getSyncStatus(), getSyncSettings()])
    if (seq !== syncUiSeq) return
    const params = new URLSearchParams(window.location.search)
    const isReasonQuota = params.get("reason") === "quota_exceeded"
    const quotaExceeded = status.state === "quota_exceeded" || isReasonQuota

    if (isReasonQuota) {
        window.history.replaceState({}, document.title, window.location.pathname)
    }

    if (syncBanner) {
        syncBanner.hidden = !quotaExceeded || bannerDismissed || !settings.syncEnabled
    }
}

function renderCurrentClips(): void {
    if (!clipGrid || !template) return
    renderClipGrid(clipGrid, template, currentClips, currentSyncedIds, currentSyncEnabled, {
        onOpen: (clip) => void openClipInYouTube(clip),
        onDelete: (clip) => void removeClip(clip.id)
    })
}

async function refreshFromLocal(): Promise<void> {
    const seq = ++refreshSeq
    const [clips, settings] = await Promise.all([readClips(), getSyncSettings()])
    const syncedIds = settings.syncEnabled ? await getSyncedClipIds() : new Set<string>()
    if (seq !== refreshSeq) return
    currentClips = clips
    currentSyncedIds = syncedIds
    currentSyncEnabled = settings.syncEnabled
    renderCurrentClips()
    await refreshSyncUI()
}

async function loadClips(): Promise<void> {
    try {
        await requestSyncReconcile()
    } catch {
        // Fall back to local clips when sync is unavailable
    }
    await refreshFromLocal()
}

async function removeClip(id: string): Promise<void> {
    await deleteClip(id)
    await refreshFromLocal()
}

bannerDismissBtn?.addEventListener("click", () => {
    bannerDismissed = true
    if (syncBanner) {
        syncBanner.hidden = true
    }
})

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local") {
        if (hasLocalClipChange(changes) || changes[SYNC_STATUS_KEY] || changes[SYNC_SETTINGS_KEY]) {
            void refreshFromLocal()
        }
        return
    }

    if (areaName === "sync" && hasSyncClipChange(changes)) {
        void refreshFromLocal()
    }
})

void loadClips()
