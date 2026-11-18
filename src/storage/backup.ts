import { formatClipCount, getUiLocale, t } from "../i18n/index"
import type { Clip } from "../types"
import { formatLibraryTime } from "../utils/time"
import { normalizeTitle, sanitizeClipTitle } from "../utils/youtube"
import { getClipTimestamp } from "../utils/clip"
import { readClips, saveClipsLocally, writeClips } from "./localStorage"
import { requestSyncImport } from "./syncClient"
import { resetSyncSettingsForReplace } from "./syncEngine"
import { getSyncedClipIds } from "./syncRemote"
import { getSyncSettings, saveSyncStatus } from "./syncState"
import { addTombstones, getTombstones, removeTombstones } from "./tombstones"

const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

function getExtensionVersion(): string {
    if (typeof chrome !== "undefined" && typeof chrome.runtime?.getManifest === "function") {
        return chrome.runtime.getManifest().version || "1.0.0"
    }
    return "1.0.0"
}

export type ImportErrorCode = "INVALID_JSON" | "MISSING_CLIPS_ARRAY" | "NO_VALID_CLIPS"

/**
 * Typed error raised during JSON backup import so callers can localize user-facing alerts.
 */
export class ImportError extends Error {
    readonly code: ImportErrorCode

    constructor(code: ImportErrorCode) {
        super(code)
        this.name = "ImportError"
        this.code = code
    }
}

/**
 * Escapes characters that break Markdown link syntax [label](url)
 */
function escapeMarkdownLinkText(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]")
}

/**
 * Escapes inline formatting characters (asterisks, underscores, backticks, backslashes, and tildes)
 */
function escapeMarkdownInline(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/[*_`~]/g, "\\$&")
}

/**
 * Formats clips into a formatted JSON string payload.
 */
export function formatClipsAsJson(clips: Clip[]): string {
    const payload = {
        app: "Carpe - Clip Vault for YouTube",
        version: getExtensionVersion(),
        exportedAt: new Date().toISOString(),
        clipCount: clips.length,
        clips
    }
    return JSON.stringify(payload, null, 2)
}

/**
 * Export all clips from storage as formatted JSON string
 */
export async function exportClipsAsJson(): Promise<string> {
    const data = await readClips()
    return formatClipsAsJson(data)
}

function formatExportDate(): string {
    const now = new Date()
    try {
        return new Intl.DateTimeFormat(getUiLocale()).format(now)
    } catch {
        return new Intl.DateTimeFormat("en").format(now)
    }
}

/**
 * Formats clips into Markdown note format (Obsidian / Notion friendly).
 */
export function formatClipsAsMarkdown(clips: Clip[]): string {
    const formattedDate = formatExportDate()
    const summary = t("mdExportSummary", [formattedDate, formatClipCount(clips.length)])
    const lines: string[] = [`# ${t("mdExportHeading")}`, `_${summary}_\n`]

    for (const clip of clips) {
        const start = Math.max(0, Math.floor(Number(clip.start) || 0))
        const url = `https://www.youtube.com/watch?v=${encodeURIComponent(
            clip.videoId
        )}&t=${start}s&clipId=${encodeURIComponent(clip.id)}`
        const title = escapeMarkdownLinkText(clip.title || t("untitledClip"))
        const videoTitle = escapeMarkdownInline(clip.videoTitle || t("mdDefaultVideoTitle"))
        const range = `${formatLibraryTime(clip.start)} - ${formatLibraryTime(clip.end)}`
        lines.push(`- [${title}](${url}) \`(${range})\` - *${videoTitle}*`)
    }

    return lines.join("\n")
}

/**
 * Export all clips from storage as Markdown note format (Obsidian / Notion friendly)
 */
export async function exportClipsAsMarkdown(): Promise<string> {
    const data = await readClips()
    return formatClipsAsMarkdown(data)
}

/**
 * Validates candidate clip data from raw input and produces a sanitized Clip instance, or null if invalid.
 */
export function validateAndSanitizeClipCandidate(candidate: unknown, fallbackNow: number): Clip | null {
    if (!candidate || typeof candidate !== "object") return null
    const raw = candidate as Partial<Clip>
    const id = typeof raw.id === "string" ? raw.id.trim() : ""
    const videoId = typeof raw.videoId === "string" ? raw.videoId.trim() : ""
    const start = raw.start
    const end = raw.end

    if (
        !id ||
        !VIDEO_ID_PATTERN.test(videoId) ||
        typeof start !== "number" ||
        typeof end !== "number" ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end <= start
    ) {
        return null
    }

    const createdAt =
        typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) && raw.createdAt > 0
            ? raw.createdAt
            : fallbackNow
    const updatedAt =
        typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) && raw.updatedAt > 0
            ? raw.updatedAt
            : createdAt

    return {
        id,
        videoId,
        title: sanitizeClipTitle(typeof raw.title === "string" ? raw.title : ""),
        videoTitle: normalizeTitle(typeof raw.videoTitle === "string" ? raw.videoTitle : "").slice(0, 200),
        start,
        end,
        createdAt,
        updatedAt
    }
}

/**
 * Parses and validates an imported JSON payload into valid, sanitized, and deduplicated clips.
 */
export function parseAndValidateImportPayload(jsonText: string): Clip[] {
    let parsed: unknown
    try {
        parsed = JSON.parse(jsonText)
    } catch {
        throw new ImportError("INVALID_JSON")
    }

    let rawList: unknown[] = []
    if (Array.isArray(parsed)) {
        rawList = parsed
    } else if (parsed && typeof parsed === "object" && "clips" in parsed && Array.isArray(parsed.clips)) {
        rawList = parsed.clips
    } else {
        throw new ImportError("MISSING_CLIPS_ARRAY")
    }

    const dedupedClips = new Map<string, Clip>()
    const fallbackNow = Date.now()
    for (const item of rawList) {
        const clip = validateAndSanitizeClipCandidate(item, fallbackNow)
        if (!clip) continue

        const prev = dedupedClips.get(clip.id)
        if (!prev || getClipTimestamp(clip) >= getClipTimestamp(prev)) {
            dedupedClips.set(clip.id, clip)
        }
    }

    const validClips = Array.from(dedupedClips.values())
    if (validClips.length === 0) {
        throw new ImportError("NO_VALID_CLIPS")
    }
    return validClips
}

async function applyImportLocally(
    validClips: Clip[],
    mode: "merge" | "replace",
    syncEnabled: boolean
): Promise<{ clipsToSave: Clip[]; removedIds: string[] }> {
    const activeTombstones = await getTombstones(syncEnabled)
    const resolveRestoredClip = (clip: Clip): Clip => {
        const deletedAt = Object.hasOwn(activeTombstones, clip.id) ? activeTombstones[clip.id] : undefined
        if (deletedAt !== undefined && getClipTimestamp(clip) <= deletedAt) {
            return { ...clip, updatedAt: deletedAt + 1 }
        }
        return clip
    }

    if (mode === "replace") {
        const [previousLocal, previousSynced] = await Promise.all([
            readClips(),
            syncEnabled ? getSyncedClipIds() : Promise.resolve(new Set<string>())
        ])
        const validIdSet = new Set(validClips.map((clip) => clip.id))
        const removedIds = Array.from(new Set([...previousLocal.map((clip) => clip.id), ...previousSynced])).filter(
            (id) => !validIdSet.has(id)
        )

        const clipsToSave = validClips.map(resolveRestoredClip)
        const sorted = [...clipsToSave].sort((a, b) => b.updatedAt - a.updatedAt)
        await writeClips(sorted)
        return { clipsToSave, removedIds }
    }

    const existingLocal = await readClips()
    const existingById = new Map(existingLocal.map((clip) => [clip.id, clip]))
    const clipsToSave: Clip[] = []
    for (const clip of validClips) {
        const restoredClip = resolveRestoredClip(clip)
        const existing = existingById.get(restoredClip.id)
        if (!existing) {
            clipsToSave.push(restoredClip)
        } else if (getClipTimestamp(restoredClip) > getClipTimestamp(existing)) {
            clipsToSave.push({
                ...existing,
                ...restoredClip
            })
        }
    }
    await saveClipsLocally(clipsToSave)
    return { clipsToSave, removedIds: [] }
}

async function propagateImportSync(
    importedIdList: string[],
    removedIds: string[],
    mode: "merge" | "replace",
    syncEnabled: boolean
): Promise<void> {
    if (syncEnabled) {
        try {
            await requestSyncImport(importedIdList, removedIds, mode)
        } catch (err) {
            if (mode === "replace") {
                await resetSyncSettingsForReplace(false).catch((e) => {
                    console.warn("[Carpe Backup] Rollback resetSyncSettings failed:", e)
                })
            }
            if (removedIds.length > 0) {
                await addTombstones(removedIds, false).catch((e) => {
                    console.warn("[Carpe Backup] Rollback addTombstones failed:", e)
                })
            }
            await removeTombstones(importedIdList, false).catch((e) => {
                console.warn("[Carpe Backup] Rollback removeTombstones failed:", e)
            })
            const message = err instanceof Error ? err.message : String(err || "Sync error")
            await saveSyncStatus({ state: "error", message }).catch((e) => {
                console.warn("[Carpe Backup] Rollback saveSyncStatus failed:", e)
            })
        }
        return
    }

    if (mode === "replace") {
        await resetSyncSettingsForReplace(false)
    }
    if (removedIds.length > 0) {
        await addTombstones(removedIds, false)
    }
    await removeTombstones(importedIdList, false)
}

/**
 * Import clips from JSON string with schema validation and merge/replace options
 */
export async function importClipsFromJson(
    jsonText: string,
    mode: "merge" | "replace" = "merge"
): Promise<{ imported: number; total: number }> {
    const validClips = parseAndValidateImportPayload(jsonText)
    const settings = await getSyncSettings()

    const { clipsToSave, removedIds } = await applyImportLocally(validClips, mode, settings.syncEnabled)
    const importedIdList = clipsToSave.map((clip) => clip.id)

    await propagateImportSync(importedIdList, removedIds, mode, settings.syncEnabled)

    const totalCount = (await readClips()).length
    return { imported: clipsToSave.length, total: totalCount }
}
