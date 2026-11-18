import { formatClipCount, initPageI18n, t } from "../src/i18n/index"
import {
    ARCHIVE_VISIBLE_THRESHOLD,
    calculateArchiveRemoveCount,
    exportClipsAsJson,
    exportClipsAsMarkdown,
    getSyncedClipIds,
    getSyncSettings,
    getSyncStatus,
    hasLocalClipChange,
    hasSyncClipChange,
    importClipsFromJson,
    readClips,
    requestSyncArchive,
    requestSyncReconcile,
    saveSyncSettings
} from "../src/storage/index"
import { SYNC_SETTINGS_KEY, SYNC_STATUS_KEY } from "../src/types"
import { downloadFile, mountAppShell, readTextFile } from "./common"
import { getImportErrorMessage, renderSettingsView, SettingsViewElements, showFeedback } from "./settingsView"

// Settings Elements
const syncToggleCheckbox = document.querySelector<HTMLInputElement>("#sync-toggle-checkbox")
const settingsSyncBadge = document.querySelector<HTMLElement>("#settings-sync-badge")
const statLocalCount = document.querySelector<HTMLElement>("#stat-local-count")
const statSyncCount = document.querySelector<HTMLElement>("#stat-sync-count")
const statSyncState = document.querySelector<HTMLElement>("#stat-sync-state")
const syncErrorDetail = document.querySelector<HTMLElement>("#sync-error-detail")
const archiveBox = document.querySelector<HTMLElement>("#archive-box")
const archiveSyncBtn = document.querySelector<HTMLButtonElement>("#archive-sync-btn")
const exportJsonBtn = document.querySelector<HTMLButtonElement>("#export-json-btn")
const exportMdBtn = document.querySelector<HTMLButtonElement>("#export-md-btn")
const importBtn = document.querySelector<HTMLButtonElement>("#import-btn")
const importFileInput = document.querySelector<HTMLInputElement>("#import-file-input")
const feedbackBanner = document.querySelector<HTMLElement>("#settings-feedback")

const viewElements: SettingsViewElements = {
    syncToggleCheckbox,
    settingsSyncBadge,
    statLocalCount,
    statSyncCount,
    statSyncState,
    syncErrorDetail,
    archiveBox,
    archiveSyncBtn
}

// Initialize i18n and shared app shell
initPageI18n("settingsPageTitle")
mountAppShell("settings")

let currentSyncedCount = 0
let statsSeq = 0

async function refreshStats(): Promise<void> {
    const seq = ++statsSeq
    const [localClips, status, settings, syncedIds] = await Promise.all([
        readClips(),
        getSyncStatus(),
        getSyncSettings(),
        getSyncedClipIds()
    ])
    if (seq !== statsSeq) return

    const syncedCount = settings.syncEnabled ? syncedIds.size : 0
    currentSyncedCount = syncedCount

    const removeCount = calculateArchiveRemoveCount(syncedCount)
    const canArchive =
        settings.syncEnabled &&
        removeCount > 0 &&
        (syncedCount >= ARCHIVE_VISIBLE_THRESHOLD || (status.state === "quota_exceeded" && syncedCount > 1))

    renderSettingsView(viewElements, {
        syncEnabled: settings.syncEnabled,
        localClipCount: localClips.length,
        syncedCount,
        status,
        removeCount,
        canArchive
    })
}

// Sync toggle listener
syncToggleCheckbox?.addEventListener("change", async () => {
    const enabled = syncToggleCheckbox.checked
    syncToggleCheckbox.disabled = true
    try {
        await saveSyncSettings({ syncEnabled: enabled })
        if (enabled) {
            await requestSyncReconcile()
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        showFeedback(feedbackBanner, message, "error")
    } finally {
        syncToggleCheckbox.disabled = false
        await refreshStats()
    }
})

// Archive older clips
archiveSyncBtn?.addEventListener("click", async () => {
    const removeCount = calculateArchiveRemoveCount(currentSyncedCount)
    if (removeCount <= 0) {
        return
    }

    if (!confirm(t("archiveConfirm", [formatClipCount(removeCount)]))) {
        return
    }

    archiveSyncBtn.disabled = true
    try {
        const liveCount = (await getSyncedClipIds()).size
        const keepCount = Math.max(1, (liveCount || currentSyncedCount) - removeCount)
        const result = await requestSyncArchive(keepCount)
        if (result.error) {
            showFeedback(feedbackBanner, t("archiveFailed", [result.error]), "error")
        } else {
            showFeedback(
                feedbackBanner,
                t("archiveSuccess", [formatClipCount(result.removed), formatClipCount(result.remaining)]),
                "success"
            )
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        showFeedback(feedbackBanner, t("archiveFailed", [message]), "error")
    } finally {
        archiveSyncBtn.disabled = false
        await refreshStats()
    }
})

// Export handlers
exportJsonBtn?.addEventListener("click", async () => {
    exportJsonBtn.disabled = true
    try {
        const json = await exportClipsAsJson()
        const date = new Date().toISOString().slice(0, 10)
        downloadFile(json, `carpe-backup-${date}.json`, "application/json")
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        showFeedback(feedbackBanner, message, "error")
    } finally {
        exportJsonBtn.disabled = false
    }
})

exportMdBtn?.addEventListener("click", async () => {
    exportMdBtn.disabled = true
    try {
        const md = await exportClipsAsMarkdown()
        const date = new Date().toISOString().slice(0, 10)
        downloadFile(md, `carpe-clips-${date}.md`, "text/markdown")
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        showFeedback(feedbackBanner, message, "error")
    } finally {
        exportMdBtn.disabled = false
    }
})

// Import handlers
importBtn?.addEventListener("click", () => {
    importFileInput?.click()
})

importFileInput?.addEventListener("change", async () => {
    const file = importFileInput.files?.[0]
    if (!file) {
        return
    }

    if (importBtn) {
        importBtn.disabled = true
    }
    try {
        const content = await readTextFile(file)
        const res = await importClipsFromJson(content, "merge")
        showFeedback(
            feedbackBanner,
            t("importSuccess", [formatClipCount(res.imported), formatClipCount(res.total)]),
            "success"
        )
        await refreshStats()
    } catch (err) {
        const errorKey =
            err instanceof Error && err.message === "FILE_READ_ERROR"
                ? t("importErrReadFile")
                : getImportErrorMessage(err)
        showFeedback(feedbackBanner, t("importFailed", [errorKey]), "error")
    } finally {
        importFileInput.value = ""
        if (importBtn) {
            importBtn.disabled = false
        }
    }
})

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local") {
        if (hasLocalClipChange(changes) || changes[SYNC_STATUS_KEY] || changes[SYNC_SETTINGS_KEY]) {
            void refreshStats()
        }
        return
    }

    if (areaName === "sync" && hasSyncClipChange(changes)) {
        void refreshStats()
    }
})

void refreshStats()
