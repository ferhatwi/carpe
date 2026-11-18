import assert from "node:assert/strict"
import test from "node:test"
import { getUiLocale } from "../src/i18n"
import * as storage from "../src/storage/index"
import * as types from "../src/types"
import { createChromeMock } from "./helpers/chrome-mock"

test("importClipsFromJson validates timestamps/videoIds and uses manifest version on export", async () => {
    createChromeMock()
    const exported = JSON.parse(storage.formatClipsAsJson([]))
    assert.equal(exported.version, "1.2.3")

    const payload = JSON.stringify({
        clips: [
            { id: "bad1", videoId: "bad/id", start: 0, end: 5 },
            { id: "bad2", videoId: "dQw4w9WgXcQ", start: 10, end: 5 },
            { id: "bad3", videoId: "dQw4w9WgXcQ", start: -1, end: 5 },
            {
                id: "good1",
                videoId: "dQw4w9WgXcQ",
                title: "Good",
                videoTitle: "Video",
                start: 2,
                end: 12
            }
        ]
    })

    const res = await storage.importClipsFromJson(payload, "merge")
    assert.equal(res.imported, 1)
    const clips = await storage.readClips()
    assert.equal(clips.length, 1)
    assert.equal(clips[0].id, "good1")
})

test("importClipsFromJson clears tombstones so re-imported clips survive sync pull", async () => {
    const mock = createChromeMock()
    await storage.upsertClip({
        id: "t1",
        videoId: "dQw4w9WgXcQ",
        title: "Deleted",
        videoTitle: "V",
        start: 1,
        end: 5,
        createdAt: 100,
        updatedAt: 100
    })
    await storage.deleteClip("t1")
    assert.ok(mock.stores.sync[types.SYNC_TOMBSTONES_KEY])

    await storage.importClipsFromJson(
        JSON.stringify([
            {
                id: "t1",
                videoId: "dQw4w9WgXcQ",
                title: "Restored",
                videoTitle: "V",
                start: 1,
                end: 5,
                createdAt: 100,
                updatedAt: 100
            }
        ]),
        "merge"
    )
    const clips = await storage.readClips()
    assert.equal(clips.length, 1)
    assert.equal(clips[0].title, "Restored")
    assert.ok(`${types.SYNC_PREFIX}t1` in mock.stores.sync)
})

test("importClipsFromJson dedupes IDs, truncates titles, and preserves newer local clips on merge", async () => {
    createChromeMock()
    await storage.upsertClip({
        id: "keep_newer",
        videoId: "dQw4w9WgXcQ",
        title: "Local Newer",
        videoTitle: "V",
        start: 5,
        end: 10,
        createdAt: 100,
        updatedAt: 500
    })

    const longTitle = "A".repeat(120)
    const longVideoTitle = "B".repeat(300)
    const res = await storage.importClipsFromJson(
        JSON.stringify([
            {
                id: "dup1",
                videoId: "dQw4w9WgXcQ",
                title: "Older Dup",
                videoTitle: "V",
                start: 1,
                end: 3,
                createdAt: 100,
                updatedAt: 100
            },
            {
                id: "dup1",
                videoId: "dQw4w9WgXcQ",
                title: `  ${longTitle}  `,
                videoTitle: longVideoTitle,
                start: 1,
                end: 4,
                createdAt: 100,
                updatedAt: 300
            },
            {
                id: "keep_newer",
                videoId: "dQw4w9WgXcQ",
                title: "Stale Backup",
                videoTitle: "Old V",
                start: 1,
                end: 2,
                createdAt: 100,
                updatedAt: 200
            }
        ]),
        "merge"
    )

    assert.equal(res.imported, 1)
    assert.equal(res.total, 2)
    const clips = await storage.readClips()
    const dup = clips.find((c) => c.id === "dup1")
    const newer = clips.find((c) => c.id === "keep_newer")
    assert.equal(dup?.title.length, 60)
    assert.equal(dup?.videoTitle.length, 200)
    assert.equal(newer?.title, "Local Newer")
})

test("replace-mode import removes and tombstones old clips before sync pull", async () => {
    const mock = createChromeMock()
    await storage.upsertClip({
        id: "old1",
        videoId: "dQw4w9WgXcQ",
        title: "Old",
        videoTitle: "V",
        start: 1,
        end: 5,
        createdAt: 100,
        updatedAt: 100
    })

    const res = await storage.importClipsFromJson(
        JSON.stringify([
            {
                id: "new1",
                videoId: "dQw4w9WgXcQ",
                title: "Replacement",
                videoTitle: "V",
                start: 10,
                end: 20,
                createdAt: 200,
                updatedAt: 200
            }
        ]),
        "replace"
    )

    assert.equal(res.imported, 1)
    assert.equal(res.total, 1)
    const clips = await storage.readClips()
    assert.deepEqual(
        clips.map((c) => c.id),
        ["new1"]
    )
    assert.equal(mock.stores.sync[`${types.SYNC_PREFIX}old1`], undefined)
    assert.ok(`${types.SYNC_PREFIX}new1` in mock.stores.sync)
})

test("importClipsFromJson syncs imported backups older than archiveCutoff and replace resets archiveCutoff", async () => {
    const mock = createChromeMock()
    for (let i = 1; i <= 3; i++) {
        await storage.upsertClip({
            id: `old_${i}`,
            videoId: "dQw4w9WgXcQ",
            title: `Old ${i}`,
            videoTitle: "V",
            start: i,
            end: i + 2,
            createdAt: i * 100,
            updatedAt: i * 100
        })
    }
    await storage.archiveOldSyncClips(1)
    assert.equal((await storage.getSyncSettings()).archiveCutoff, 200)

    // Merging an older backup (ts=50 <= 200) must still sync that imported clip without waking archived old_1/old_2
    await storage.importClipsFromJson(
        JSON.stringify([
            {
                id: "backup_old",
                videoId: "dQw4w9WgXcQ",
                title: "Restored Old Backup",
                videoTitle: "V",
                start: 10,
                end: 15,
                createdAt: 50,
                updatedAt: 50
            }
        ]),
        "merge"
    )
    assert.ok(`${types.SYNC_PREFIX}backup_old` in mock.stores.sync)
    assert.equal(mock.stores.sync[`${types.SYNC_PREFIX}old_1`], undefined)
    assert.equal(mock.stores.sync[`${types.SYNC_PREFIX}old_2`], undefined)

    await storage.importClipsFromJson(
        JSON.stringify([
            {
                id: "fresh_1",
                videoId: "dQw4w9WgXcQ",
                title: "Fresh",
                videoTitle: "V",
                start: 1,
                end: 4,
                createdAt: 600,
                updatedAt: 600
            }
        ]),
        "replace"
    )
    assert.equal((await storage.getSyncSettings()).archiveCutoff, undefined)
    assert.equal((mock.stores.sync[types.SYNC_CONFIG_KEY] as { archiveCutoff?: number }).archiveCutoff, undefined)
})

test("importClipsFromJson ignores non-positive timestamps and clears archiveCutoff when syncEnabled is false", async () => {
    const mock = createChromeMock()
    const payload = JSON.stringify({
        clips: [
            {
                id: "zeroTs",
                videoId: "dQw4w9WgXcQ",
                title: "Zero",
                videoTitle: "V",
                start: 1,
                end: 5,
                createdAt: 0,
                updatedAt: 0
            }
        ]
    })

    const res = await storage.importClipsFromJson(payload)
    assert.equal(res.imported, 1)
    assert.ok(`${types.SYNC_PREFIX}zeroTs` in mock.stores.sync)
    const saved = (await storage.readClips()).find((c) => c.id === "zeroTs")
    assert.ok(saved && saved.createdAt > 0 && saved.updatedAt > 0)

    await storage.saveSyncSettings({ syncEnabled: false, archiveCutoff: 5000 })
    await storage.importClipsFromJson(
        JSON.stringify({
            clips: [
                {
                    id: "off1",
                    videoId: "dQw4w9WgXcQ",
                    title: "Offline",
                    videoTitle: "V",
                    start: 1,
                    end: 5,
                    createdAt: 100,
                    updatedAt: 100
                }
            ]
        }),
        "replace"
    )
    assert.equal((await storage.getSyncSettings()).archiveCutoff, undefined)
})

test("runStorageMigrations initializes fresh install to CURRENT_SCHEMA_VERSION", async () => {
    const mock = createChromeMock()
    assert.equal(mock.stores.local[types.SCHEMA_VERSION_KEY], undefined)

    await storage.runStorageMigrations()

    assert.equal(mock.stores.local[types.SCHEMA_VERSION_KEY], types.CURRENT_SCHEMA_VERSION)
})

test("formatClipsAsMarkdown and exportClipsAsMarkdown normalize locales and fall back on invalid locale", async () => {
    const mock = createChromeMock()
    const runtime = globalThis.chrome.runtime as unknown as { id?: string }
    runtime.id = "test-ext-id"
    let uiLanguage = "pt_BR"
    const i18n = globalThis.chrome.i18n as {
        getUILanguage: () => string
        getMessage: (key: string, subs?: string | string[]) => string
    }
    i18n.getUILanguage = () => uiLanguage
    i18n.getMessage = (key: string, subs?: string | string[]) =>
        subs === undefined ? key : `${key}:${Array.isArray(subs) ? subs.join("|") : subs}`

    const clip: types.Clip = {
        id: "md1",
        videoId: "dQw4w9WgXcQ",
        title: "Note [One]",
        videoTitle: "Video *Title*",
        start: 10,
        end: 20,
        createdAt: 100,
        updatedAt: 100
    }

    assert.equal(getUiLocale(), "pt-BR")
    const ptMd = storage.formatClipsAsMarkdown([clip])
    const expectedPtDate = new Intl.DateTimeFormat("pt-BR").format(new Date())
    assert.ok(ptMd.includes(expectedPtDate), `Expected markdown to include pt-BR date ${expectedPtDate}`)

    uiLanguage = "invalid_locale!!!"
    assert.equal(getUiLocale(), "invalid-locale!!!")
    const fallbackMd = storage.formatClipsAsMarkdown([clip])
    const expectedEnDate = new Intl.DateTimeFormat("en").format(new Date())
    assert.ok(fallbackMd.includes(expectedEnDate), `Expected fallback markdown to include en date ${expectedEnDate}`)

    mock.stores.local[`${types.LOCAL_CLIP_PREFIX}md1`] = clip
    const exportedMd = await storage.exportClipsAsMarkdown()
    assert.ok(exportedMd.includes("Note \\[One\\]"))
})

test("replace-mode import removes old sync clips before pushing tombstones or config under quota", async () => {
    const mock = createChromeMock()
    await storage.upsertClip({
        id: "quota_old1",
        videoId: "dQw4w9WgXcQ",
        title: "Old 1",
        videoTitle: "V",
        start: 1,
        end: 5,
        createdAt: 100,
        updatedAt: 100
    })
    await storage.saveSyncSettings({ archiveCutoff: 500 })

    // Simulate sync storage at quota until old clips are removed
    const origSet = mock.syncArea.set
    const origRemove = mock.syncArea.remove
    let quotaFull = true
    mock.syncArea.set = async (payload: Record<string, unknown>) => {
        if (quotaFull) {
            throw new Error("QUOTA_BYTES quota exceeded")
        }
        return origSet(payload)
    }
    mock.syncArea.remove = async (keys: string | string[]) => {
        const res = await origRemove(keys)
        quotaFull = false
        return res
    }

    const res = await storage.importClipsFromJson(
        JSON.stringify([
            {
                id: "quota_new1",
                videoId: "dQw4w9WgXcQ",
                title: "Replacement",
                videoTitle: "V",
                start: 2,
                end: 6,
                createdAt: 200,
                updatedAt: 200
            }
        ]),
        "replace"
    )
    mock.syncArea.set = origSet
    mock.syncArea.remove = origRemove

    assert.equal(res.imported, 1)
    assert.equal(mock.stores.sync[`${types.SYNC_PREFIX}quota_old1`], undefined)
    assert.ok(`${types.SYNC_PREFIX}quota_new1` in mock.stores.sync)
    assert.ok((mock.stores.sync[types.SYNC_TOMBSTONES_KEY] as Record<string, number>)?.quota_old1)
    assert.equal((mock.stores.sync[types.SYNC_CONFIG_KEY] as { archiveCutoff?: number }).archiveCutoff, undefined)
    assert.equal((await storage.getSyncStatus()).state, "healthy")
})

test("importClipsFromJson preserves restored clips on transient tombstone error and offline restore", async () => {
    const mock = createChromeMock()
    const baseClip: types.Clip = {
        id: "restored1",
        videoId: "dQw4w9WgXcQ",
        title: "Restored",
        videoTitle: "V",
        start: 1,
        end: 5,
        createdAt: 100,
        updatedAt: 200
    }
    await storage.upsertClip(baseClip)
    await storage.deleteClip(baseClip.id)
    const deletedAt1 = (mock.stores.local[types.SYNC_TOMBSTONES_KEY] as Record<string, number>).restored1
    assert.ok(deletedAt1 > 0)

    const origSet = mock.syncArea.set
    mock.syncArea.set = async (payload: Record<string, unknown>) => {
        if (types.SYNC_TOMBSTONES_KEY in payload) {
            throw new Error("Transient tombstone failure")
        }
        return origSet(payload)
    }

    const res1 = await storage.importClipsFromJson(JSON.stringify([baseClip]), "merge")
    mock.syncArea.set = origSet
    assert.equal(res1.imported, 1)
    assert.equal((await storage.getSyncStatus()).state, "error")

    const afterImport = (await storage.readClips()).find((c) => c.id === "restored1")
    assert.ok(afterImport && afterImport.updatedAt > deletedAt1)

    await storage.pullAndMergeSyncClips()
    assert.equal((await storage.getSyncStatus()).state, "healthy")
    assert.ok(`${types.SYNC_PREFIX}restored1` in mock.stores.sync)
    assert.ok((await storage.readClips()).some((c) => c.id === "restored1"))

    // Offline restore while remote still holds a tombstone for an older timestamp
    const offlineClip: types.Clip = { ...baseClip, id: "restored2", updatedAt: 150 }
    await storage.upsertClip(offlineClip)
    await storage.deleteClip(offlineClip.id)
    const deletedAt2 = (mock.stores.sync[types.SYNC_TOMBSTONES_KEY] as Record<string, number>).restored2
    assert.ok(deletedAt2 > 0)

    await storage.saveSyncSettings({ syncEnabled: false })
    await storage.importClipsFromJson(JSON.stringify([offlineClip]), "replace")
    await storage.saveSyncSettings({ syncEnabled: true })

    await storage.pullAndMergeSyncClips()
    assert.ok((await storage.readClips()).some((c) => c.id === "restored2"))
    assert.ok(`${types.SYNC_PREFIX}restored2` in mock.stores.sync)
})
