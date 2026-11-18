import assert from "node:assert/strict"
import test from "node:test"
import * as storage from "../src/storage/index"
import * as localHelpers from "../src/storage/localStorage"
import * as types from "../src/types"
import { createChromeMock } from "./helpers/chrome-mock"

function expectStatus<S extends types.SyncStatus["state"]>(
    status: types.SyncStatus,
    state: S
): Extract<types.SyncStatus, { state: S }> {
    assert.equal(status.state, state)
    return status as Extract<types.SyncStatus, { state: S }>
}

test("upsertClip handles non-quota sync error without marking healthy", async () => {
    const mock = createChromeMock()
    mock.setSyncError(new Error("MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded"))

    const res = await storage.upsertClip({
        id: "c1",
        videoId: "dQw4w9WgXcQ",
        title: "Test",
        videoTitle: "Video",
        start: 10,
        end: 20,
        createdAt: 1000,
        updatedAt: 1000
    })

    assert.equal(res.syncQuotaExceeded, false)
    assert.equal((await storage.getSyncStatus()).state, "error")
})

test("upsertClip detects true quota exceeded and accurate syncedCount", async () => {
    const mock = createChromeMock()
    await storage.upsertClip({
        id: "c1",
        videoId: "dQw4w9WgXcQ",
        title: "One",
        videoTitle: "Video",
        start: 1,
        end: 5,
        createdAt: 1000,
        updatedAt: 1000
    })
    let status = expectStatus(await storage.getSyncStatus(), "healthy")
    assert.equal(status.syncedCount, 1)

    await storage.upsertClip({
        id: "c1",
        videoId: "dQw4w9WgXcQ",
        title: "One updated",
        videoTitle: "Video",
        start: 1,
        end: 6,
        createdAt: 1000,
        updatedAt: 2000
    })
    status = expectStatus(await storage.getSyncStatus(), "healthy")
    assert.equal(status.syncedCount, 1)

    mock.setSyncError(new Error("QUOTA_BYTES quota exceeded"))
    const res = await storage.upsertClip({
        id: "c2",
        videoId: "dQw4w9WgXcQ",
        title: "Two",
        videoTitle: "Video",
        start: 7,
        end: 10,
        createdAt: 3000,
        updatedAt: 3000
    })
    assert.equal(res.syncQuotaExceeded, true)
    expectStatus(await storage.getSyncStatus(), "quota_exceeded")
})

test("deleteClip respects syncEnabled=false and does not touch sync storage", async () => {
    const mock = createChromeMock()
    await storage.upsertClip({
        id: "c1",
        videoId: "dQw4w9WgXcQ",
        title: "Keep in cloud",
        videoTitle: "Video",
        start: 1,
        end: 5,
        createdAt: 1000,
        updatedAt: 1000
    })
    await storage.saveSyncSettings({ syncEnabled: false })
    await storage.deleteClip("c1")

    assert.equal((await storage.readClips()).length, 0)
    assert.ok(`${types.SYNC_PREFIX}c1` in mock.stores.sync)
    assert.equal(mock.stores.sync[types.SYNC_TOMBSTONES_KEY], undefined)
})

test("pullAndMergeSyncClips merges, avoids double-count, and handles tombstones", async () => {
    const mock = createChromeMock()
    mock.stores.sync[`${types.SYNC_PREFIX}r1`] = {
        id: "r1",
        videoId: "dQw4w9WgXcQ",
        title: "Remote",
        videoTitle: "Video",
        start: 0,
        end: 5,
        createdAt: 1000,
        updatedAt: 2000
    }
    await storage.saveClipLocally({
        id: "r1",
        videoId: "dQw4w9WgXcQ",
        title: "Local Newer",
        videoTitle: "Video",
        start: 0,
        end: 5,
        createdAt: 1000,
        updatedAt: 3000
    })
    const res = await storage.pullAndMergeSyncClips()
    assert.equal(res.pushed, 1)
    assert.equal(res.totalCount, 1)
    const status = expectStatus(await storage.getSyncStatus(), "healthy")
    assert.equal(status.syncedCount, 1)
})

test("concurrent saveClipLocally calls do not overwrite each other", async () => {
    createChromeMock()
    const clipA: types.Clip = {
        id: "a",
        videoId: "dQw4w9WgXcQ",
        title: "A",
        videoTitle: "V",
        start: 0,
        end: 2,
        createdAt: 100,
        updatedAt: 100
    }
    const clipB: types.Clip = {
        id: "b",
        videoId: "dQw4w9WgXcQ",
        title: "B",
        videoTitle: "V",
        start: 3,
        end: 5,
        createdAt: 200,
        updatedAt: 200
    }
    await Promise.all([storage.saveClipLocally(clipA), storage.saveClipLocally(clipB)])
    const saved = await storage.readClips()
    assert.equal(saved.length, 2)
    assert.deepEqual(saved.map((c) => c.id).sort(), ["a", "b"])
})

test("archiveOldSyncClips keeps maxSyncItems unchanged when nothing removed and transitions partial cleanly", async () => {
    createChromeMock()
    for (let i = 1; i <= 5; i++) {
        await storage.upsertClip({
            id: `p${i}`,
            videoId: "dQw4w9WgXcQ",
            title: `Clip ${i}`,
            videoTitle: "V",
            start: i,
            end: i + 2,
            createdAt: i * 100,
            updatedAt: i * 100
        })
    }
    const noopRes = await storage.archiveOldSyncClips(100)
    assert.equal(noopRes.removed, 0)
    assert.equal(noopRes.remaining, 5)
    assert.equal((await storage.getSyncSettings()).maxSyncItems, 250)

    const partialRes = await storage.archiveOldSyncClips(2)
    assert.equal(partialRes.removed, 3)
    assert.equal(partialRes.remaining, 2)
    const status = expectStatus(await storage.getSyncStatus(), "partial")
    assert.equal(status.syncedCount, 2)
    assert.equal(status.localOnlyCount, 3)
})

test("deleteClip reconciles quota_exceeded state when space frees or unsynced clip is deleted", async () => {
    const mock = createChromeMock()
    await storage.upsertClip({
        id: "s1",
        videoId: "dQw4w9WgXcQ",
        title: "Synced",
        videoTitle: "V",
        start: 1,
        end: 5,
        createdAt: 100,
        updatedAt: 100
    })

    mock.setSyncError(new Error("QUOTA_BYTES quota exceeded"))
    await storage.upsertClip({
        id: "u1",
        videoId: "dQw4w9WgXcQ",
        title: "Unsynced",
        videoTitle: "V",
        start: 6,
        end: 10,
        createdAt: 200,
        updatedAt: 200
    })
    assert.equal((await storage.getSyncStatus()).state, "quota_exceeded")

    mock.setSyncError(null)
    await storage.deleteClip("u1")
    let status = expectStatus(await storage.getSyncStatus(), "healthy")
    assert.equal(status.syncedCount, 1)

    mock.setSyncError(new Error("QUOTA_BYTES quota exceeded"))
    await storage.upsertClip({
        id: "u2",
        videoId: "dQw4w9WgXcQ",
        title: "Unsynced 2",
        videoTitle: "V",
        start: 11,
        end: 15,
        createdAt: 300,
        updatedAt: 300
    })
    assert.equal((await storage.getSyncStatus()).state, "quota_exceeded")

    mock.setSyncError(null)
    await storage.deleteClip("s1")
    status = expectStatus(await storage.getSyncStatus(), "healthy")
    assert.equal(status.syncedCount, 1)
    assert.ok(`${types.SYNC_PREFIX}u2` in mock.stores.sync)
})

test("pullAndMergeSyncClips pushes incrementally and salvages partial progress on quota", async () => {
    const mock = createChromeMock()
    const origSyncSet = mock.syncArea.set
    let allowClipWrites = 2
    mock.syncArea.set = async (items: Record<string, unknown>) => {
        const clipKeys = Object.keys(items).filter((k) => k.startsWith(types.SYNC_PREFIX))
        if (clipKeys.length > allowClipWrites) {
            throw new Error("QUOTA_BYTES quota exceeded")
        }
        if (clipKeys.length > 0) {
            allowClipWrites -= clipKeys.length
        }
        return origSyncSet(items)
    }

    for (let i = 1; i <= 4; i++) {
        await storage.saveClipLocally({
            id: `q${i}`,
            videoId: "dQw4w9WgXcQ",
            title: `Clip ${i}`,
            videoTitle: "V",
            start: i,
            end: i + 2,
            createdAt: i * 100,
            updatedAt: i * 100
        })
    }

    await storage.pullAndMergeSyncClips()
    const status = expectStatus(await storage.getSyncStatus(), "quota_exceeded")
    assert.equal(status.syncedCount, 2)
})

test("upsertClip enforces maxSyncItems cap, protects unpulled remote clips, and retains quota_exceeded on updates", async () => {
    const mock = createChromeMock()
    await storage.saveSyncSettings({ maxSyncItems: 2 })

    for (let i = 1; i <= 3; i++) {
        await storage.upsertClip({
            id: `m${i}`,
            videoId: "dQw4w9WgXcQ",
            title: `M${i}`,
            videoTitle: "V",
            start: i,
            end: i + 2,
            createdAt: i * 100,
            updatedAt: i * 100
        })
    }
    let syncedIds = await storage.getSyncedClipIds()
    assert.deepEqual([...syncedIds].sort(), ["m2", "m3"])

    mock.stores.sync[`${types.SYNC_PREFIX}remote_new`] = {
        id: "remote_new",
        videoId: "dQw4w9WgXcQ",
        title: "Remote Newer",
        videoTitle: "V",
        start: 1,
        end: 3,
        createdAt: 900,
        updatedAt: 900
    }
    mock.setSyncError(new Error("Temporary sync error"))
    await storage.upsertClip({
        id: "fail_evict",
        videoId: "dQw4w9WgXcQ",
        title: "Fails",
        videoTitle: "V",
        start: 1,
        end: 3,
        createdAt: 800,
        updatedAt: 800
    })
    assert.ok(`${types.SYNC_PREFIX}remote_new` in mock.stores.sync)
    assert.ok(`${types.SYNC_PREFIX}m3` in mock.stores.sync)

    mock.setSyncError(null)
    await storage.upsertClip({
        id: "m_newest",
        videoId: "dQw4w9WgXcQ",
        title: "Local Newest",
        videoTitle: "V",
        start: 1,
        end: 3,
        createdAt: 1000,
        updatedAt: 1000
    })
    syncedIds = await storage.getSyncedClipIds()
    assert.deepEqual([...syncedIds].sort(), ["m_newest", "remote_new"])
    mock.stores.sync[`${types.SYNC_PREFIX}m3`] = mock.stores.local[`${types.LOCAL_CLIP_PREFIX}m3`]

    await storage.saveSyncSettings({ maxSyncItems: 5 })
    mock.setSyncError(new Error("QUOTA_BYTES quota exceeded"))
    await storage.upsertClip({
        id: "m4",
        videoId: "dQw4w9WgXcQ",
        title: "M4",
        videoTitle: "V",
        start: 4,
        end: 6,
        createdAt: 400,
        updatedAt: 400
    })
    assert.equal((await storage.getSyncStatus()).state, "quota_exceeded")

    mock.setSyncError(null)
    await storage.upsertClip({
        id: "m3",
        videoId: "dQw4w9WgXcQ",
        title: "M3 Updated",
        videoTitle: "V",
        start: 3,
        end: 6,
        createdAt: 300,
        updatedAt: 500
    })
    assert.equal((await storage.getSyncStatus()).state, "quota_exceeded")
})

test("archiveOldSyncClips syncs archiveCutoff across devices, handles config deferral, and backfills newer clips", async () => {
    const mock = createChromeMock()
    for (let i = 1; i <= 4; i++) {
        await storage.upsertClip({
            id: `a${i}`,
            videoId: "dQw4w9WgXcQ",
            title: `A${i}`,
            videoTitle: "V",
            start: i,
            end: i + 2,
            createdAt: i * 100,
            updatedAt: i * 100
        })
    }

    const prevSet = mock.syncArea.set
    const prevRemove = mock.syncArea.remove
    const origDateNow = Date.now
    const frozenNow = origDateNow()
    Date.now = () => frozenNow
    try {
        const ok = await storage.archiveOldSyncClips(2)
        assert.equal(ok.error, undefined)
        assert.equal(ok.removed, 2)
        assert.equal(ok.remaining, 2)
        assert.equal((mock.stores.sync[types.SYNC_CONFIG_KEY] as { archiveCutoff: number }).archiveCutoff, 200)
        assert.equal((await storage.getSyncSettings()).maxSyncItems, 250)

        mock.stores.local[types.SYNC_SETTINGS_KEY] = { syncEnabled: true, maxSyncItems: 250 }
        const pullRes = await storage.pullAndMergeSyncClips()
        assert.equal(pullRes.pushed, 0)
        const syncedSettings = await storage.getSyncSettings()
        assert.equal(syncedSettings.archiveCutoff, 200)
        assert.equal(syncedSettings.maxSyncItems, 250)

        await storage.upsertClip({
            id: "a5",
            videoId: "dQw4w9WgXcQ",
            title: "A5",
            videoTitle: "V",
            start: 5,
            end: 7,
            createdAt: 500,
            updatedAt: 500
        })
        assert.ok(`${types.SYNC_PREFIX}a5` in mock.stores.sync)

        let quotaFull = true
        let blockConfigWrite = true
        mock.syncArea.set = async (payload: Record<string, unknown>) => {
            if (quotaFull) {
                throw new Error("QUOTA_BYTES quota exceeded")
            }
            if (blockConfigWrite && types.SYNC_CONFIG_KEY in payload) {
                blockConfigWrite = false
                throw new Error("Transient config write failure")
            }
            return prevSet(payload)
        }
        mock.syncArea.remove = async (keys: string | string[]) => {
            const res = await prevRemove(keys)
            quotaFull = false
            return res
        }
        const archiveUnderQuota = await storage.archiveOldSyncClips(2)
        assert.equal(archiveUnderQuota.error, undefined)
        assert.equal(archiveUnderQuota.removed, 1)
        assert.equal(archiveUnderQuota.remaining, 2)
        assert.equal((await storage.getSyncSettings()).archiveCutoff, 300)
        assert.equal((mock.stores.sync[types.SYNC_CONFIG_KEY] as { archiveCutoff: number }).archiveCutoff, 200)
        await storage.pullAndMergeSyncClips()
        assert.equal((mock.stores.sync[types.SYNC_CONFIG_KEY] as { archiveCutoff: number }).archiveCutoff, 300)
    } finally {
        Date.now = origDateNow
        mock.syncArea.set = prevSet
        mock.syncArea.remove = prevRemove
    }

    mock.syncArea.remove = async () => {
        throw new Error("Partial remove failure")
    }
    const partialFail = await storage.archiveOldSyncClips(1)
    assert.equal(partialFail.removed, 0)
    assert.equal(partialFail.error, "Partial remove failure")
    assert.equal((await storage.getSyncSettings()).archiveCutoff, 300)
    mock.syncArea.remove = prevRemove

    mock.setSyncError(new Error("Sync service offline"))
    const fail = await storage.archiveOldSyncClips(1)
    assert.equal(fail.removed, 0)
    assert.equal(fail.error, "Sync service offline")

    const mock2 = createChromeMock()
    for (let i = 1; i <= 3; i++) {
        await storage.upsertClip({
            id: `bk${i}`,
            videoId: "dQw4w9WgXcQ",
            title: `BK${i}`,
            videoTitle: "V",
            start: i,
            end: i + 2,
            createdAt: i * 100,
            updatedAt: i * 100
        })
    }
    mock2.setSyncError(new Error("QUOTA_BYTES quota exceeded"))
    await storage.upsertClip({
        id: "bk4",
        videoId: "dQw4w9WgXcQ",
        title: "Pending Newer",
        videoTitle: "V",
        start: 4,
        end: 6,
        createdAt: 400,
        updatedAt: 400
    })
    assert.equal((await storage.getSyncStatus()).state, "quota_exceeded")
    mock2.setSyncError(null)

    const backfillArchive = await storage.archiveOldSyncClips(2)
    assert.equal(backfillArchive.removed, 1)
    assert.equal(backfillArchive.remaining, 3)
    assert.ok(`${types.SYNC_PREFIX}bk4` in mock2.stores.sync)
    assert.equal(mock2.stores.sync[`${types.SYNC_PREFIX}bk1`], undefined)
})

test("saveMergedClipsLocally prevents mid-pull TOCTOU from overwriting newer local edits or resurrecting deletions", async () => {
    const mock = createChromeMock()
    await storage.saveClipLocally({
        id: "edit1",
        videoId: "dQw4w9WgXcQ",
        title: "Old Local",
        videoTitle: "V",
        start: 1,
        end: 2,
        createdAt: 50,
        updatedAt: 50
    })
    await storage.saveClipLocally({
        id: "del1",
        videoId: "dQw4w9WgXcQ",
        title: "To Delete",
        videoTitle: "V",
        start: 1,
        end: 2,
        createdAt: 50,
        updatedAt: 50
    })
    mock.stores.sync[`${types.SYNC_PREFIX}edit1`] = {
        id: "edit1",
        videoId: "dQw4w9WgXcQ",
        title: "Older Remote",
        videoTitle: "V",
        start: 1,
        end: 2,
        createdAt: 50,
        updatedAt: 100
    }
    mock.stores.sync[`${types.SYNC_PREFIX}del1`] = {
        id: "del1",
        videoId: "dQw4w9WgXcQ",
        title: "Deleted Mid Pass",
        videoTitle: "V",
        start: 1,
        end: 2,
        createdAt: 50,
        updatedAt: 100
    }

    const knownAtStart = new Set(["edit1", "del1"])
    await storage.saveClipLocally({
        id: "edit1",
        videoId: "dQw4w9WgXcQ",
        title: "Concurrent Newer Edit",
        videoTitle: "V",
        start: 1,
        end: 2,
        createdAt: 50,
        updatedAt: 200
    })
    await localHelpers.removeClipLocally("del1")

    const mergedCount = await localHelpers.saveMergedClipsLocally(
        [
            mock.stores.sync[`${types.SYNC_PREFIX}edit1`] as types.Clip,
            mock.stores.sync[`${types.SYNC_PREFIX}del1`] as types.Clip,
            {
                id: "brand_new",
                videoId: "dQw4w9WgXcQ",
                title: "From Remote",
                videoTitle: "V",
                start: 1,
                end: 2,
                createdAt: 120,
                updatedAt: 120
            }
        ],
        knownAtStart
    )
    assert.equal(mergedCount, 1)
    assert.equal((mock.stores.local[`${types.LOCAL_CLIP_PREFIX}edit1`] as types.Clip).title, "Concurrent Newer Edit")
    assert.equal(mock.stores.local[`${types.LOCAL_CLIP_PREFIX}del1`], undefined)
    assert.equal((mock.stores.local[`${types.LOCAL_CLIP_PREFIX}brand_new`] as types.Clip).title, "From Remote")
})

test("upsertClip and deleteClip remain local-first when service worker sendMessage fails", async () => {
    const mock = createChromeMock()
    mock.setSendMessage(async () => {
        throw new Error("Could not establish connection. Receiving end does not exist.")
    })

    const res = await storage.upsertClip({
        id: "swdown1",
        videoId: "dQw4w9WgXcQ",
        title: "Offline SW",
        videoTitle: "V",
        start: 1,
        end: 5,
        createdAt: 100,
        updatedAt: 100
    })
    assert.equal(res.syncQuotaExceeded, false)
    assert.equal((await storage.readClips()).length, 1)
    assert.equal((await storage.getSyncStatus()).state, "error")

    await storage.deleteClip("swdown1")
    assert.equal((await storage.readClips()).length, 0)
    assert.ok((mock.stores.local[types.SYNC_TOMBSTONES_KEY] as Record<string, number>).swdown1)

    await storage.saveSyncSettings({ archiveCutoff: 500 })
    const importRes = await storage.importClipsFromJson(
        JSON.stringify([
            {
                id: "swdown_imp1",
                videoId: "dQw4w9WgXcQ",
                title: "Imported Offline SW",
                videoTitle: "V",
                start: 1,
                end: 4,
                createdAt: 100,
                updatedAt: 100
            }
        ]),
        "replace"
    )
    assert.equal(importRes.imported, 1)
    assert.equal((await storage.getSyncSettings()).archiveCutoff, undefined)
    assert.equal((await storage.getSyncStatus()).state, "error")
})

test("tabId-scoped pending playback keeps concurrent clips for the same video isolated", async () => {
    const mock = createChromeMock()
    await storage.setPendingPlayback({ clipId: "c1", videoId: "dQw4w9WgXcQ", tabId: 101 })
    await storage.setPendingPlayback({ clipId: "c2", videoId: "dQw4w9WgXcQ", tabId: 102 })

    const tab102 = await storage.consumePendingPlayback("dQw4w9WgXcQ", 102)
    assert.equal(tab102?.clipId, "c2")
    assert.equal(await storage.consumePendingPlayback("dQw4w9WgXcQ", 102), null)

    let writeCalls = 0
    const origSet = mock.localArea.set
    const origRemove = mock.localArea.remove
    mock.localArea.set = async (items: Record<string, unknown>) => {
        writeCalls++
        return origSet(items)
    }
    mock.localArea.remove = async (keys: string | string[]) => {
        writeCalls++
        return origRemove(keys)
    }
    assert.equal(await storage.consumePendingPlayback("dQw4w9WgXcQ", 999), null)
    assert.equal(writeCalls, 0)
    mock.localArea.set = origSet
    mock.localArea.remove = origRemove

    const tab101 = await storage.consumePendingPlayback("dQw4w9WgXcQ", 101)
    assert.equal(tab101?.clipId, "c1")

    writeCalls = 0
    mock.localArea.set = async (items: Record<string, unknown>) => {
        writeCalls++
        return origSet(items)
    }
    mock.localArea.remove = async (keys: string | string[]) => {
        writeCalls++
        return origRemove(keys)
    }
    assert.equal(await storage.consumePendingPlayback("dQw4w9WgXcQ", 101), null)
    assert.equal(writeCalls, 0)
    mock.localArea.set = origSet
    mock.localArea.remove = origRemove
})

test("deleteClip and pullAndMergeSyncClips surface sync remove/tombstone failures instead of reporting healthy", async () => {
    const mock = createChromeMock()

    await storage.upsertClip({
        id: "delErr1",
        videoId: "dQw4w9WgXcQ",
        title: "DelErr",
        videoTitle: "V",
        start: 1,
        end: 5,
        createdAt: 100,
        updatedAt: 100
    })
    assert.ok(`${types.SYNC_PREFIX}delErr1` in mock.stores.sync)

    const origRemove = mock.syncArea.remove
    mock.syncArea.remove = async () => {
        throw new Error("MAX_WRITE_OPERATIONS_PER_MINUTE exceeded")
    }
    await storage.deleteClip("delErr1")
    mock.syncArea.remove = origRemove
    assert.equal((await storage.getSyncStatus()).state, "error")

    await storage.pullAndMergeSyncClips()
    await storage.upsertClip({
        id: "delErr2",
        videoId: "dQw4w9WgXcQ",
        title: "DelErr2",
        videoTitle: "V",
        start: 2,
        end: 6,
        createdAt: 200,
        updatedAt: 200
    })
    const origSet = mock.syncArea.set
    mock.syncArea.set = async (payload: Record<string, unknown>) => {
        if (types.SYNC_TOMBSTONES_KEY in payload) {
            throw new Error("Transient tombstone sync error")
        }
        return origSet(payload)
    }
    await storage.deleteClip("delErr2")
    assert.equal((await storage.getSyncStatus()).state, "error")

    await storage.pullAndMergeSyncClips()
    assert.equal((await storage.getSyncStatus()).state, "error")

    mock.syncArea.set = origSet
    await storage.pullAndMergeSyncClips()
    assert.equal((await storage.getSyncStatus()).state, "healthy")
})

test("runCloudUpsertClip preserves error state with unsynced clips, tracks eviction errors, and handles empty fallback count", async () => {
    const mock = createChromeMock()

    mock.setSyncError(new Error("Temporary outage"))
    await storage.upsertClip({
        id: "err1",
        videoId: "dQw4w9WgXcQ",
        title: "Err1",
        videoTitle: "V",
        start: 1,
        end: 3,
        createdAt: 100,
        updatedAt: 100
    })
    assert.equal((await storage.getSyncStatus()).state, "error")

    mock.setSyncError(null)
    await storage.upsertClip({
        id: "ok1",
        videoId: "dQw4w9WgXcQ",
        title: "Ok1",
        videoTitle: "V",
        start: 4,
        end: 6,
        createdAt: 200,
        updatedAt: 200
    })
    assert.equal((await storage.getSyncStatus()).state, "error")

    mock.stores.local[types.SYNC_SETTINGS_KEY] = { syncEnabled: true, maxSyncItems: 1 }
    const origRemove = mock.syncArea.remove
    mock.syncArea.remove = async () => {
        throw new Error("Evict failed")
    }
    await storage.upsertClip({
        id: "ok2",
        videoId: "dQw4w9WgXcQ",
        title: "Ok2",
        videoTitle: "V",
        start: 7,
        end: 9,
        createdAt: 300,
        updatedAt: 300
    })
    mock.syncArea.remove = origRemove
    const evictStatus = expectStatus(await storage.getSyncStatus(), "error")
    assert.equal(evictStatus.syncedCount, 2)

    delete mock.stores.sync[`${types.SYNC_PREFIX}ok1`]
    delete mock.stores.sync[`${types.SYNC_PREFIX}ok2`]
    const origSet = mock.syncArea.set
    mock.syncArea.set = async () => {
        throw new Error("Transient set error")
    }
    await storage.upsertClip({
        id: "ok3",
        videoId: "dQw4w9WgXcQ",
        title: "Ok3",
        videoTitle: "V",
        start: 10,
        end: 12,
        createdAt: 400,
        updatedAt: 400
    })
    mock.syncArea.set = origSet
    const emptyStatus = expectStatus(await storage.getSyncStatus(), "error")
    assert.equal(emptyStatus.syncedCount, 0)
})

test("pullAndMergeSyncClips frees stale remote clips before tombstone sync and flags quota on tombstone failure", async () => {
    const mock = createChromeMock()
    const now = Date.now()
    const tombstoneAt = now - 1000
    mock.stores.sync[`${types.SYNC_PREFIX}stale1`] = {
        id: "stale1",
        videoId: "dQw4w9WgXcQ",
        title: "Stale Remote",
        videoTitle: "V",
        start: 1,
        end: 5,
        createdAt: now - 5000,
        updatedAt: now - 5000
    }
    mock.stores.local[types.SYNC_TOMBSTONES_KEY] = { stale1: tombstoneAt }

    // Case 1: Sync is at QUOTA_BYTES until stale1 is removed from cloud
    const origSet = mock.syncArea.set
    const origRemove = mock.syncArea.remove
    let quotaFullUntilStaleRemoved = true
    mock.syncArea.set = async (payload: Record<string, unknown>) => {
        if (quotaFullUntilStaleRemoved && types.SYNC_TOMBSTONES_KEY in payload) {
            throw new Error("QUOTA_BYTES quota exceeded")
        }
        return origSet(payload)
    }
    mock.syncArea.remove = async (keys: string | string[]) => {
        const res = await origRemove(keys)
        quotaFullUntilStaleRemoved = false
        return res
    }

    await storage.pullAndMergeSyncClips()
    assert.equal(mock.stores.sync[`${types.SYNC_PREFIX}stale1`], undefined)
    assert.equal((mock.stores.sync[types.SYNC_TOMBSTONES_KEY] as Record<string, number>).stale1, tombstoneAt)
    assert.equal((await storage.getSyncStatus()).state, "healthy")

    // Case 2: If tombstone sync still hits QUOTA_BYTES even with zero clips to push, status becomes quota_exceeded
    mock.stores.local[types.SYNC_TOMBSTONES_KEY] = { stale1: tombstoneAt, deleted_local: now }
    mock.syncArea.remove = origRemove
    mock.syncArea.set = async (payload: Record<string, unknown>) => {
        if (types.SYNC_TOMBSTONES_KEY in payload) {
            throw new Error("QUOTA_BYTES quota exceeded")
        }
        return origSet(payload)
    }

    await storage.pullAndMergeSyncClips()
    mock.syncArea.set = origSet
    const quotaStatus = expectStatus(await storage.getSyncStatus(), "quota_exceeded")
    assert.equal(quotaStatus.syncedCount, 0)
})

test("deleteClip exits quota_exceeded to partial when only archived clips remain local-only", async () => {
    const mock = createChromeMock()
    await storage.saveClipLocally({
        id: "arch1",
        videoId: "dQw4w9WgXcQ",
        title: "Archived",
        videoTitle: "V",
        start: 1,
        end: 5,
        createdAt: 100,
        updatedAt: 100
    })
    await storage.saveSyncSettings({ archiveCutoff: 200 })
    await storage.upsertClip({
        id: "active1",
        videoId: "dQw4w9WgXcQ",
        title: "Active",
        videoTitle: "V",
        start: 2,
        end: 6,
        createdAt: 300,
        updatedAt: 300
    })

    const origSet = mock.syncArea.set
    mock.syncArea.set = async () => {
        throw new Error("QUOTA_BYTES quota exceeded")
    }
    const failRes = await storage.upsertClip({
        id: "localFail1",
        videoId: "dQw4w9WgXcQ",
        title: "Failed",
        videoTitle: "V",
        start: 3,
        end: 7,
        createdAt: 400,
        updatedAt: 400
    })
    mock.syncArea.set = origSet
    assert.equal(failRes.syncQuotaExceeded, true)
    assert.equal((await storage.getSyncStatus()).state, "quota_exceeded")

    await storage.deleteClip("localFail1")
    const status = expectStatus(await storage.getSyncStatus(), "partial")
    assert.equal(status.syncedCount, 1)
    assert.equal(status.localOnlyCount, 1)
})

test("upsertClip preserves error status when unpropagated local tombstones remain", async () => {
    const mock = createChromeMock()
    await storage.upsertClip({
        id: "delPending1",
        videoId: "dQw4w9WgXcQ",
        title: "Pending Delete",
        videoTitle: "V",
        start: 1,
        end: 5,
        createdAt: 100,
        updatedAt: 100
    })

    const origRemove = mock.syncArea.remove
    mock.syncArea.remove = async () => {
        throw new Error("Transient remove failure")
    }
    await storage.deleteClip("delPending1")
    mock.syncArea.remove = origRemove
    assert.equal((await storage.getSyncStatus()).state, "error")

    await storage.upsertClip({
        id: "fresh1",
        videoId: "dQw4w9WgXcQ",
        title: "Fresh",
        videoTitle: "V",
        start: 2,
        end: 6,
        createdAt: 200,
        updatedAt: 200
    })
    assert.ok(`${types.SYNC_PREFIX}fresh1` in mock.stores.sync)
    assert.equal((await storage.getSyncStatus()).state, "error")

    await storage.pullAndMergeSyncClips()
    assert.equal(mock.stores.sync[`${types.SYNC_PREFIX}delPending1`], undefined)
    assert.equal((await storage.getSyncStatus()).state, "healthy")
})

test("pullAndMergeSyncClips retries pending sync config after overflow eviction and surfaces config errors", async () => {
    const mock = createChromeMock()
    await storage.saveSyncSettings({ maxSyncItems: 1, archiveCutoff: 150, configUpdatedAt: 2000 })
    const oldClip: types.Clip = {
        id: "overflow_old",
        videoId: "dQw4w9WgXcQ",
        title: "Old",
        videoTitle: "V",
        start: 1,
        end: 5,
        createdAt: 200,
        updatedAt: 200
    }
    const newClip: types.Clip = {
        id: "overflow_new",
        videoId: "dQw4w9WgXcQ",
        title: "New",
        videoTitle: "V",
        start: 2,
        end: 6,
        createdAt: 300,
        updatedAt: 300
    }
    await storage.saveClipLocally(oldClip)
    await storage.saveClipLocally(newClip)
    mock.stores.sync[`${types.SYNC_PREFIX}overflow_old`] = oldClip
    mock.stores.sync[`${types.SYNC_PREFIX}overflow_new`] = newClip

    const origSet = mock.syncArea.set
    const origRemove = mock.syncArea.remove
    let quotaFullUntilEvict = true
    mock.syncArea.set = async (payload: Record<string, unknown>) => {
        if (quotaFullUntilEvict && types.SYNC_CONFIG_KEY in payload) {
            throw new Error("QUOTA_BYTES quota exceeded")
        }
        return origSet(payload)
    }
    mock.syncArea.remove = async (keys: string | string[]) => {
        const res = await origRemove(keys)
        quotaFullUntilEvict = false
        return res
    }

    await storage.pullAndMergeSyncClips()
    mock.syncArea.set = origSet
    mock.syncArea.remove = origRemove

    assert.equal(mock.stores.sync[`${types.SYNC_PREFIX}overflow_old`], undefined)
    assert.equal((mock.stores.sync[types.SYNC_CONFIG_KEY] as { updatedAt: number }).updatedAt, 2000)
    const afterEvictStatus = expectStatus(await storage.getSyncStatus(), "partial")
    assert.equal(afterEvictStatus.syncedCount, 1)
    assert.equal(afterEvictStatus.localOnlyCount, 1)

    await storage.saveSyncSettings({ configUpdatedAt: 3000 })
    mock.syncArea.set = async (payload: Record<string, unknown>) => {
        if (types.SYNC_CONFIG_KEY in payload) {
            throw new Error("Config write error")
        }
        return origSet(payload)
    }
    await storage.pullAndMergeSyncClips()
    mock.syncArea.set = origSet

    const errStatus = expectStatus(await storage.getSyncStatus(), "error")
    assert.match(errStatus.message, /Config write error/)
})

test("clipService provides a unified CRUD API with getClip, getClipsForVideo, and readClips", async () => {
    createChromeMock()
    await storage.saveSyncSettings({ syncEnabled: false })

    const clipA: types.Clip = {
        id: "clip_a",
        videoId: "vid_1",
        title: "Clip A",
        videoTitle: "Vid 1",
        start: 5,
        end: 15,
        createdAt: 1000,
        updatedAt: 1000
    }
    const clipB: types.Clip = {
        id: "clip_b",
        videoId: "vid_1",
        title: "Clip B",
        videoTitle: "Vid 1",
        start: 20,
        end: 30,
        createdAt: 2000,
        updatedAt: 2000
    }
    const clipC: types.Clip = {
        id: "clip_c",
        videoId: "vid_2",
        title: "Clip C",
        videoTitle: "Vid 2",
        start: 0,
        end: 10,
        createdAt: 3000,
        updatedAt: 3000
    }

    await storage.upsertClip(clipA)
    await storage.upsertClip(clipB)
    await storage.upsertClip(clipC)

    // getClip direct lookup
    const fetchedA = await storage.getClip("clip_a")
    assert.deepEqual(fetchedA, clipA)
    const missing = await storage.getClip("nonexistent")
    assert.equal(missing, null)

    // getClipsForVideo video-scoped lookup
    const vid1Clips = await storage.getClipsForVideo("vid_1")
    assert.equal(vid1Clips.length, 2)
    assert.deepEqual(
        vid1Clips.map((c) => c.id),
        ["clip_b", "clip_a"]
    )

    const vid2Clips = await storage.getClipsForVideo("vid_2")
    assert.equal(vid2Clips.length, 1)
    assert.equal(vid2Clips[0].id, "clip_c")

    // deleteClip removes and confirms absent
    await storage.deleteClip("clip_a")
    assert.equal(await storage.getClip("clip_a"), null)
    assert.equal((await storage.getClipsForVideo("vid_1")).length, 1)
})

test("readStorageRecord safely reads objects and handles corrupt or missing values", async () => {
    const mock = createChromeMock()
    mock.stores.local.validKey = { foo: 123, bar: 456 }
    mock.stores.local.corruptedKey = "just a string"
    mock.stores.local.arrayKey = [1, 2, 3]

    const valid = await storage.readStorageRecord<number>("validKey", "local")
    assert.deepEqual(valid, { foo: 123, bar: 456 })

    const corrupt = await storage.readStorageRecord("corruptedKey", "local")
    assert.deepEqual(corrupt, {})

    const arr = await storage.readStorageRecord("arrayKey", "local")
    assert.deepEqual(arr, {})

    const missing = await storage.readStorageRecord("nonexistent", "local")
    assert.deepEqual(missing, {})
})

test("syncClient sends typed RPC messages to background service worker", async () => {
    const mock = createChromeMock()
    const sentMessages: unknown[] = []
    mock.setSendMessage(async (msg: unknown) => {
        sentMessages.push(msg)
        return { ok: true, data: { success: true } }
    })

    const sampleClip: types.Clip = {
        id: "rpc_clip",
        videoId: "vid_rpc",
        title: "RPC Test",
        videoTitle: "Video",
        start: 0,
        end: 10,
        createdAt: 100,
        updatedAt: 100
    }

    await storage.requestSyncUpsert(sampleClip)
    assert.equal(sentMessages.length, 1)
    assert.deepEqual(sentMessages[0], { action: "carpe:sync", op: "upsert", clip: sampleClip })

    await storage.requestSyncDelete("rpc_clip")
    assert.equal(sentMessages.length, 2)
    assert.deepEqual(sentMessages[1], { action: "carpe:sync", op: "delete", id: "rpc_clip" })

    await storage.requestSyncReconcile()
    assert.equal(sentMessages.length, 3)
    assert.deepEqual(sentMessages[2], { action: "carpe:sync", op: "reconcile" })

    await storage.requestSyncArchive(5)
    assert.equal(sentMessages.length, 4)
    assert.deepEqual(sentMessages[3], { action: "carpe:sync", op: "archive", keepCount: 5 })

    await storage.requestSyncImport(["c1"], ["c2"], "merge")
    assert.equal(sentMessages.length, 5)
    assert.deepEqual(sentMessages[4], {
        action: "carpe:sync",
        op: "import",
        importedIds: ["c1"],
        removedIds: ["c2"],
        mode: "merge"
    })
})
