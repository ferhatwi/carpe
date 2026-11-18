import { t } from "../i18n/index"
import {
    deleteClip,
    getClip,
    hasLocalClipChange,
    hasSyncClipChange,
    requestTabPendingPlayback,
    upsertClip
} from "../storage/index"
import { type ActiveClip, type Clip, LOCAL_CLIP_PREFIX, SYNC_SETTINGS_KEY } from "../types"
import { isContextInvalidatedError, isExtensionContextValid } from "../utils/extension"
import { getDuration, isAdShowing } from "../utils/youtube"
import { buildClipRecord, getSaveSuccessToast, handleSyncQuotaExceededToast } from "./clipOperations"
import { ClipPlaybackController } from "./clipPlaybackController"
import { ClipShelf } from "./clipShelf"
import { PlayerOverlayView } from "./playerOverlayView"
import { TimelineTrimmer } from "./timelineTrimmer"

/**
 * Scoped session for an active YouTube video.
 * Manages playback boundaries, timeline trimming, and clip CRUD for the mounted player.
 */
export class VideoSession {
    readonly videoId: string
    readonly video: HTMLVideoElement
    readonly view: PlayerOverlayView
    private readonly playback: ClipPlaybackController
    private readonly shelf: ClipShelf
    private readonly trimmer: TimelineTrimmer
    private readonly onInvalidated?: () => void

    private editingClipId: string | null = null
    private isSaving = false
    private isMutatingClip = false
    private isDisposed = false
    private lastAdState: boolean | null = null

    get activeClip(): ActiveClip | null {
        return this.playback.clip
    }

    constructor(videoId: string, video: HTMLVideoElement, view: PlayerOverlayView, onInvalidated?: () => void) {
        this.videoId = videoId
        this.video = video
        this.view = view
        this.onInvalidated = onInvalidated

        this.playback = new ClipPlaybackController(this.video, this.view.playerElement, {
            onProgressUpdate: () => this.updateVideoClipProgress(),
            onActiveClipChange: () => this.renderSelection(),
            isBoundarySuspended: () => Boolean(this.editingClipId),
            getSuspendedBoundaryEnd: () => {
                if (this.trimmer.currentAnchor === "end") {
                    return null
                }
                return this.trimmer.currentSelection?.end ?? this.activeClip?.end ?? null
            }
        })

        this.shelf = new ClipShelf(this.videoId, this.video, this.view.videoClips, {
            isHidden: () => isAdShowing(this.view.playerElement),
            onClipClick: (clip) => {
                if (this.isSaving) return
                if (isAdShowing(this.view.playerElement)) {
                    this.view.showToast(t("toastAdsPlayBlocked"))
                    return
                }
                if (this.activeClip && this.activeClip.id === clip.id) {
                    if (this.playback.isParkedAtEnd) {
                        this.activateVideoClip(clip)
                    } else {
                        this.cancelEditingClip()
                        this.clearActiveClip()
                    }
                } else {
                    this.activateVideoClip(clip)
                }
            }
        })

        this.trimmer = new TimelineTrimmer(this.video, this.view, {
            getHasActiveClip: () => Boolean(this.activeClip),
            onSelectionChange: () => this.updateVideoClipProgress(),
            onCancel: () => this.cancelEditingClip()
        })
        this.view.onLayoutUpdate = () => this.renderSelection()
        this.view.onTitleEnter = () => void this.saveCurrentClip()
        this.view.onTitleEscape = () => this.cancelEditingClip()

        this.bindUiEvents()
        if (isExtensionContextValid()) {
            chrome.storage.onChanged.addListener(this.onStorageChanged)
            void this.loadVideoClips().catch((err) => this.handleContextError(err))
            void this.initPlayback().catch((err) => this.handleContextError(err))
        }
        this.syncAdState()
    }

    private handleContextError(err: unknown): void {
        if (isContextInvalidatedError(err)) {
            this.onInvalidated?.()
            this.dispose()
            return
        }
        console.error("[Carpe Session] Storage operation failed:", err)
    }

    private ensureActiveContext(): boolean {
        if (this.isDisposed) return false
        if (!isExtensionContextValid()) {
            this.onInvalidated?.()
            this.dispose()
            return false
        }
        return true
    }

    get isMounted(): boolean {
        return this.view.isMounted
    }

    mount(): void {
        this.view.mount()
    }

    ensureMounted(): void {
        if (this.isDisposed) return
        if (!this.view.isMounted) {
            this.view.mount()
        }
    }

    syncAdState(): void {
        if (this.isDisposed) return
        const adShowing = isAdShowing(this.view.playerElement)
        if (adShowing === this.lastAdState && this.view.isMounted) {
            return
        }
        this.lastAdState = adShowing
        const display = adShowing ? "none" : ""
        this.view.button.style.display = display
        this.view.editButton.style.display = display
        this.view.deleteButton.style.display = display

        if (adShowing) {
            if (this.trimmer.currentSelection) {
                this.cancelEditingClip()
            }
            this.view.videoClips.hidden = true
        } else {
            this.ensureMounted()
            this.view.videoClips.hidden = this.view.videoClips.children.length === 0
            this.view.updateLayout()
        }
    }

    // ---------------------------------------------------------------------------
    // UI Event Bindings
    // ---------------------------------------------------------------------------

    private bindUiEvents(): void {
        this.view.button.onclick = () => this.onToggleCreateClip()
        this.view.editButton.onclick = () => void this.onEditActiveClip()
        this.view.deleteButton.onclick = () => void this.onDeleteActiveClip()
        this.view.saveButton.onclick = () => void this.saveCurrentClip()
        this.view.cancelButton.onclick = () => this.cancelEditingClip()
    }

    private onToggleCreateClip(): void {
        if (!this.ensureActiveContext()) return
        if (isAdShowing(this.view.playerElement)) {
            this.view.showToast(t("toastAdsClipBlocked"))
            return
        }
        if (getDuration(this.video) <= 0) {
            this.view.showToast(t("toastVideoNotReady"))
            return
        }
        if (!this.trimmer.currentSelection) {
            const range = this.trimmer.createDefaultRange()
            this.trimmer.setSelection(range, null)
            this.view.startControlsKeepAlive()
        }
    }

    private async onEditActiveClip(): Promise<void> {
        if (!this.ensureActiveContext() || this.editingClipId) return
        if (isAdShowing(this.view.playerElement)) {
            this.view.showToast(t("toastAdsEditBlocked"))
            return
        }
        const targetId = this.activeClip?.id
        if (!targetId) return
        // Suspend boundary stop before the async read so playback near clip.end cannot clear activeClip mid-click
        this.editingClipId = targetId
        let started = false
        try {
            const found = await getClip(targetId)
            if (this.isDisposed || this.activeClip?.id !== targetId) return
            if (found) {
                started = true
                this.startEditingClip(found)
            }
        } catch (err) {
            this.handleContextError(err)
        } finally {
            if (!started && !this.isDisposed && this.editingClipId === targetId) {
                this.editingClipId = null
                this.playback.reconcileActiveClip()
            }
        }
    }

    private async onDeleteActiveClip(): Promise<void> {
        if (!this.ensureActiveContext() || this.isMutatingClip) return
        const targetId = this.activeClip?.id
        if (!targetId) return
        this.isMutatingClip = true
        this.view.deleteButton.disabled = true
        try {
            await deleteClip(targetId)
            if (this.isDisposed) return
            if (this.activeClip?.id === targetId) {
                this.clearActiveClip()
            }
            await this.loadVideoClips()
            if (this.isDisposed) return
            this.view.showToast(t("toastClipDeleted"))
        } catch (err) {
            this.handleContextError(err)
        } finally {
            this.view.deleteButton.disabled = false
            this.isMutatingClip = false
        }
    }

    // ---------------------------------------------------------------------------
    // Trimming & Clip CRUD
    // ---------------------------------------------------------------------------

    async saveCurrentClip(): Promise<void> {
        if (!this.ensureActiveContext() || this.isSaving) return
        if (isAdShowing(this.view.playerElement)) {
            this.view.showToast(t("toastAdsClipBlocked"))
            return
        }
        const selection = this.trimmer.currentSelection
        if (!selection) return

        this.isSaving = true
        this.isMutatingClip = true
        this.view.saveButton.disabled = true
        this.view.cancelButton.disabled = true
        try {
            const targetEditId = this.editingClipId
            let originalCreatedAt: number | undefined
            if (targetEditId) {
                const existing = await getClip(targetEditId)
                if (this.isDisposed || this.editingClipId !== targetEditId || !this.trimmer.currentSelection) {
                    return
                }
                if (isAdShowing(this.view.playerElement)) {
                    this.clearEditUiState()
                    this.playback.reconcileActiveClip()
                    this.updateVideoClipProgress()
                    this.view.showToast(t("toastAdsClipBlocked"))
                    return
                }
                if (existing) {
                    originalCreatedAt = existing.createdAt
                }
            }

            const { clip, title, isUpdating } = buildClipRecord({
                videoId: this.videoId,
                selection,
                rawTitle: this.view.titleInput.value || "",
                targetEditId,
                originalCreatedAt
            })

            const saveResult = await upsertClip(clip)
            if (this.isDisposed) return

            if (this.activeClip && this.activeClip.id === clip.id) {
                this.playback.updateActiveClipRange(clip.start, clip.end)
            }

            await this.loadVideoClips()
            if (this.isDisposed) return

            if (this.editingClipId === targetEditId && this.trimmer.currentSelection === selection) {
                this.clearEditUiState()
                this.playback.reconcileActiveClip()
            }

            const message = saveResult.syncQuotaExceeded
                ? handleSyncQuotaExceededToast()
                : getSaveSuccessToast(isUpdating, title)
            this.view.showToast(message)
        } catch (err) {
            this.handleContextError(err)
        } finally {
            this.isSaving = false
            this.isMutatingClip = false
            this.view.saveButton.disabled = false
            this.view.cancelButton.disabled = false
        }
    }

    private clearEditUiState(): void {
        this.editingClipId = null
        this.trimmer.clearSelection()
        this.view.titleInput.value = ""
        this.view.titleInput.blur()
        this.view.stopControlsKeepAlive()
    }

    startEditingClip(clip: Clip): void {
        if (isAdShowing(this.view.playerElement)) {
            if (this.editingClipId === clip.id) {
                this.editingClipId = null
                this.playback.reconcileActiveClip()
            }
            this.view.showToast(t("toastAdsEditBlocked"))
            return
        }
        this.editingClipId = clip.id
        this.trimmer.setSelection({ start: Number(clip.start), end: Number(clip.end) }, null)
        this.view.titleInput.value = clip.title || ""
        this.view.startControlsKeepAlive()
        this.updateVideoClipProgress()
    }

    cancelEditingClip(): void {
        if (this.isSaving) return
        this.clearEditUiState()
        this.playback.reconcileActiveClip()
        this.updateVideoClipProgress()
    }

    activateVideoClip(clip: Clip): void {
        if (this.isSaving) return
        this.cancelEditingClip()
        this.playback.playClip(clip)
    }

    clearActiveClip(): void {
        this.playback.clearActiveClip()
    }

    async playClipById(clipId: string): Promise<boolean> {
        if (this.isSaving) return false
        const clip = await getClip(clipId)
        if (this.isDisposed || this.isSaving) return false
        if (!clip || clip.videoId !== this.videoId) {
            return false
        }
        this.activateVideoClip(clip)
        return true
    }

    // ---------------------------------------------------------------------------
    // Clip Shelf & Progress
    // ---------------------------------------------------------------------------

    async loadVideoClips(): Promise<void> {
        if (this.isDisposed) return
        this.ensureMounted()
        await this.shelf.loadClips()
        if (this.isDisposed) return
        this.updateVideoClipProgress()
        this.view.updateLayout()
    }

    updateVideoClipProgress = (): void => {
        if (this.isDisposed) return
        const selection = this.trimmer.currentSelection
        const shelfClip =
            this.activeClip && this.editingClipId === this.activeClip.id && selection
                ? { ...this.activeClip, start: selection.start, end: selection.end }
                : this.activeClip
        this.shelf.updateProgress(shelfClip)
        this.trimmer.updatePlaybackProgress()
    }

    renderSelection(): void {
        if (this.isDisposed) return
        this.trimmer.render()
    }

    // ---------------------------------------------------------------------------
    // Playback Handoff & Auto-activation
    // ---------------------------------------------------------------------------

    private async initPlayback(): Promise<void> {
        const pending = await requestTabPendingPlayback(this.videoId)
        if (this.isDisposed) return
        if (pending && pending.videoId === this.videoId) {
            await this.playClipById(pending.clipId)
            return
        }
        await this.maybeApplyClipFromUrl()
    }

    private onStorageChanged = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string): void => {
        if (!this.ensureActiveContext()) return

        if (areaName === "local") {
            if (hasLocalClipChange(changes)) {
                if (!this.isMutatingClip) {
                    if (this.activeClip) {
                        const activeKey = `${LOCAL_CLIP_PREFIX}${this.activeClip.id}`
                        if (changes[activeKey]) {
                            const next = changes[activeKey].newValue as Clip | undefined
                            if (!next) {
                                this.clearActiveClip()
                            } else if (
                                Number(next.start) !== this.activeClip.start ||
                                Number(next.end) !== this.activeClip.end
                            ) {
                                this.activateVideoClip(next)
                            }
                        }
                    }

                    if (this.editingClipId) {
                        const editKey = `${LOCAL_CLIP_PREFIX}${this.editingClipId}`
                        if (changes[editKey] && changes[editKey].newValue === undefined) {
                            this.cancelEditingClip()
                        }
                    }

                    void this.loadVideoClips().catch((err) => this.handleContextError(err))
                }
                return
            }

            if (changes[SYNC_SETTINGS_KEY] && !this.isMutatingClip) {
                void this.loadVideoClips().catch((err) => this.handleContextError(err))
            }
            return
        }

        if (areaName === "sync") {
            if (hasSyncClipChange(changes) && !this.isMutatingClip) {
                void this.loadVideoClips().catch((err) => this.handleContextError(err))
            }
        }
    }

    private async maybeApplyClipFromUrl(): Promise<void> {
        const params = new URLSearchParams(location.search)
        const clipId = params.get("clipId")
        if (!clipId) {
            return
        }
        if (this.activeClip && this.activeClip.id === clipId) {
            return
        }

        await this.playClipById(clipId)
    }

    // ---------------------------------------------------------------------------
    // Lifecycle Teardown
    // ---------------------------------------------------------------------------

    dispose(): void {
        if (this.isDisposed) return
        this.isDisposed = true
        if (isExtensionContextValid()) {
            try {
                chrome.storage.onChanged.removeListener(this.onStorageChanged)
            } catch {
                // Ignore if context was invalidated mid-teardown
            }
        }
        this.playback.dispose()
        this.shelf.dispose()
        this.editingClipId = null
        this.trimmer.dispose()
        this.view.destroy()
    }
}
