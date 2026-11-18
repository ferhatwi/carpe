import { formatClipCount, MessageKey, t } from "../src/i18n/index"
import { ImportError } from "../src/storage/index"
import { SyncStatus } from "../src/types"

export const SYNC_UI_STATE_MAP: Record<
    SyncStatus["state"],
    { className: string; badgeKey: MessageKey; statKey: MessageKey; color: string }
> = {
    disabled: {
        className: "disabled",
        badgeKey: "syncStateDisabled",
        statKey: "syncStateDisabled",
        color: "var(--sync-disabled)"
    },
    quota_exceeded: {
        className: "warning",
        badgeKey: "syncStateQuotaFull",
        statKey: "syncStateQuotaFull",
        color: "var(--sync-warning)"
    },
    error: {
        className: "error",
        badgeKey: "syncStateError",
        statKey: "syncStateError",
        color: "var(--sync-error)"
    },
    healthy: {
        className: "healthy",
        badgeKey: "syncStateActive",
        statKey: "syncStateHealthy",
        color: "var(--sync-healthy)"
    },
    partial: {
        className: "partial",
        badgeKey: "syncStatePartial",
        statKey: "syncStatePartial",
        color: "var(--sync-partial)"
    }
}

export function showFeedback(banner: HTMLElement | null, message: string, variant: "success" | "error"): void {
    if (!banner) return
    banner.textContent = message
    banner.classList.remove("success", "error")
    banner.classList.add(variant)
    banner.hidden = false
}

export function getImportErrorMessage(err: unknown): string {
    if (err instanceof ImportError) {
        switch (err.code) {
            case "INVALID_JSON":
                return t("importErrInvalidJson")
            case "MISSING_CLIPS_ARRAY":
                return t("importErrMissingClipsArray")
            case "NO_VALID_CLIPS":
                return t("importErrNoValidClips")
        }
    }
    return err instanceof Error ? err.message : String(err)
}

export interface SettingsViewElements {
    syncToggleCheckbox: HTMLInputElement | null
    settingsSyncBadge: HTMLElement | null
    statLocalCount: HTMLElement | null
    statSyncCount: HTMLElement | null
    statSyncState: HTMLElement | null
    syncErrorDetail: HTMLElement | null
    archiveBox: HTMLElement | null
    archiveSyncBtn: HTMLButtonElement | null
}

export interface SettingsViewState {
    syncEnabled: boolean
    localClipCount: number
    syncedCount: number
    status: SyncStatus
    removeCount: number
    canArchive: boolean
}

export function renderSettingsView(elements: SettingsViewElements, state: SettingsViewState): void {
    const {
        syncToggleCheckbox,
        settingsSyncBadge,
        statLocalCount,
        statSyncCount,
        statSyncState,
        syncErrorDetail,
        archiveBox,
        archiveSyncBtn
    } = elements
    const { syncEnabled, localClipCount, syncedCount, status, removeCount, canArchive } = state

    if (syncToggleCheckbox) {
        syncToggleCheckbox.checked = syncEnabled
    }

    if (statLocalCount) {
        statLocalCount.textContent = String(localClipCount)
    }

    if (statSyncCount) {
        statSyncCount.textContent = String(syncedCount)
    }

    const detailMessage = status.state === "error" || status.state === "quota_exceeded" ? (status.message ?? "") : ""

    if (settingsSyncBadge && statSyncState) {
        const uiState = SYNC_UI_STATE_MAP[status.state]
        settingsSyncBadge.classList.remove("healthy", "partial", "warning", "error", "disabled")
        settingsSyncBadge.classList.add(uiState.className)
        settingsSyncBadge.textContent = t(uiState.badgeKey)
        statSyncState.textContent =
            status.state === "partial"
                ? t("syncStatePartialCount", [formatClipCount(status.localOnlyCount)])
                : t(uiState.statKey)
        statSyncState.title = detailMessage
        statSyncState.style.color = uiState.color
    }

    if (syncErrorDetail) {
        syncErrorDetail.textContent = detailMessage
        syncErrorDetail.hidden = detailMessage.length === 0
    }

    if (archiveBox) {
        if (canArchive && archiveSyncBtn) {
            archiveSyncBtn.textContent = t("archiveBtnCount", [formatClipCount(removeCount)])
        }
        archiveBox.hidden = !canArchive
    }
}
