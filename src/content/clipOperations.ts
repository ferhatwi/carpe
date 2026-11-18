import { t } from "../i18n/index"
import { type Clip, type SelectionRange } from "../types"
import { getVideoTitle, sanitizeClipTitle } from "../utils/youtube"

let hasOpenedQuotaVaultInSession = false

export interface BuildClipParams {
    videoId: string
    selection: SelectionRange
    rawTitle: string
    targetEditId: string | null
    originalCreatedAt?: number
}

/**
 * Constructs a sanitized Clip record for creation or update.
 */
export function buildClipRecord(params: BuildClipParams): { clip: Clip; title: string; isUpdating: boolean } {
    const { videoId, selection, rawTitle, targetEditId, originalCreatedAt } = params
    const title = sanitizeClipTitle(rawTitle)
    const now = Date.now()
    const isUpdating = Boolean(targetEditId)

    const clip: Clip = {
        id: targetEditId || `${videoId}-${now}-${crypto.randomUUID().slice(0, 8)}`,
        videoId,
        title,
        videoTitle: getVideoTitle(),
        start: selection.start,
        end: selection.end,
        createdAt: isUpdating && originalCreatedAt ? originalCreatedAt : now,
        updatedAt: now
    }

    return { clip, title, isUpdating }
}

/**
 * Handles quota-exceeded alerts when sync storage limit is reached during save.
 */
export function handleSyncQuotaExceededToast(): string {
    if (!hasOpenedQuotaVaultInSession) {
        hasOpenedQuotaVaultInSession = true
        void chrome.runtime
            .sendMessage({
                action: "openVault",
                reason: "quota_exceeded"
            })
            .catch((err) => {
                console.warn("[Carpe Content] Failed to request vault open:", err)
            })
        return t("toastSavedLocalSyncFull")
    }
    return t("toastSavedLocalSyncFullBrief")
}

/**
 * Formats a localized success message for clip creation or update.
 */
export function getSaveSuccessToast(isUpdating: boolean, title: string): string {
    return isUpdating
        ? title
            ? t("toastClipUpdatedWithTitle", [title])
            : t("toastClipUpdated")
        : title
          ? t("toastClipSavedWithTitle", [title])
          : t("toastClipSaved")
}
