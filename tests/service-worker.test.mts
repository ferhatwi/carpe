import assert from "node:assert/strict"
import test from "node:test"
import * as storage from "../src/storage/index"
import * as types from "../src/types"
import { createChromeMock } from "./helpers/chrome-mock"

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!(await predicate())) {
        if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for async condition")
        }
        await new Promise((r) => setTimeout(r, 2))
    }
}

async function flushEventTurns(turns = 8): Promise<void> {
    for (let i = 0; i < turns; i++) {
        await new Promise((r) => setTimeout(r, 0))
    }
}

const mock = createChromeMock({ withRuntimeListeners: true })
await import("../src/service-worker")

test("service worker recovers from transient storage migration failure on subsequent RPC", async () => {
    // Transient migration failure must not poison ensureMigrationsReady for subsequent calls
    const origLocalGet = mock.localArea.get
    let failMigrationOnce = true
    mock.localArea.get = async (keys?: string | string[] | null) => {
        if (failMigrationOnce && keys === types.SCHEMA_VERSION_KEY) {
            failMigrationOnce = false
            throw new Error("Transient local storage read error")
        }
        return origLocalGet(keys)
    }
    const failedMigRes = await mock.dispatchRuntimeMessage<{ ok: boolean; error?: string }>({
        action: "carpe:sync",
        op: "reconcile"
    })
    assert.equal(failedMigRes.ok, false)

    const recoveredMigRes = await mock.dispatchRuntimeMessage<{ ok: boolean }>({
        action: "carpe:sync",
        op: "reconcile"
    })
    assert.equal(recoveredMigRes.ok, true)
    mock.localArea.get = origLocalGet
})

test("service worker avoids redundant sync pull echo on own clip upsert", async () => {
    // Own sync write via upsertClip must NOT trigger a redundant pullAndMergeSyncClips echo
    let syncGetNullCount = 0
    let injectMidPassRemoteClip = false
    const origSyncGet = mock.syncArea.get
    mock.syncArea.get = async (keys?: string | string[] | null) => {
        if (keys == null) syncGetNullCount++
        const res = await origSyncGet(keys)
        if (keys == null && injectMidPassRemoteClip) {
            injectMidPassRemoteClip = false
            void mock.syncArea.set({
                [`${types.SYNC_PREFIX}mid1`]: {
                    id: "mid1",
                    videoId: "dQw4w9WgXcQ",
                    title: "Mid Pass",
                    videoTitle: "V",
                    start: 2,
                    end: 4,
                    createdAt: 300,
                    updatedAt: 300
                }
            })
        }
        return res
    }

    try {
        await storage.upsertClip({
            id: "echo1",
            videoId: "dQw4w9WgXcQ",
            title: "No Echo",
            videoTitle: "V",
            start: 1,
            end: 5,
            createdAt: 100,
            updatedAt: 100
        })
        await flushEventTurns()
        assert.equal(syncGetNullCount, 1)
    } finally {
        mock.syncArea.get = origSyncGet
    }
})

test("service worker rolls back own-mutation tracking on failed write so external update is received", async () => {
    // Failed write rolls back own-mutation tracking so subsequent external write to same key is NOT swallowed
    mock.setSyncError(new Error("Temporary failure"))
    await storage.upsertClip({
        id: "rb1",
        videoId: "dQw4w9WgXcQ",
        title: "Local Only",
        videoTitle: "V",
        start: 1,
        end: 3,
        createdAt: 100,
        updatedAt: 100
    })
    mock.setSyncError(null)
    await mock.syncArea.set({
        [`${types.SYNC_PREFIX}rb1`]: {
            id: "rb1",
            videoId: "dQw4w9WgXcQ",
            title: "External Update Same Key",
            videoTitle: "V",
            start: 1,
            end: 3,
            createdAt: 100,
            updatedAt: 999
        }
    })
    await waitFor(
        () =>
            (mock.stores.local[`${types.LOCAL_CLIP_PREFIX}rb1`] as types.Clip | undefined)?.title ===
            "External Update Same Key"
    )
    assert.equal((mock.stores.local[`${types.LOCAL_CLIP_PREFIX}rb1`] as types.Clip).title, "External Update Same Key")
})

test("service worker schedules follow-up pass when external sync change arrives mid-flight", async () => {
    let injectMidPassRemoteClip = true
    const origSyncGet = mock.syncArea.get
    mock.syncArea.get = async (keys?: string | string[] | null) => {
        const res = await origSyncGet(keys)
        if (keys == null && injectMidPassRemoteClip) {
            injectMidPassRemoteClip = false
            void mock.syncArea.set({
                [`${types.SYNC_PREFIX}mid1`]: {
                    id: "mid1",
                    videoId: "dQw4w9WgXcQ",
                    title: "Mid Pass",
                    videoTitle: "V",
                    start: 2,
                    end: 4,
                    createdAt: 300,
                    updatedAt: 300
                }
            })
        }
        return res
    }

    try {
        await mock.syncArea.set({
            [`${types.SYNC_PREFIX}remote1`]: {
                id: "remote1",
                videoId: "dQw4w9WgXcQ",
                title: "From Other Device",
                videoTitle: "V",
                start: 10,
                end: 15,
                createdAt: 150,
                updatedAt: 150
            }
        })
        await waitFor(() =>
            Boolean(
                mock.stores.local[`${types.LOCAL_CLIP_PREFIX}remote1`] &&
                mock.stores.local[`${types.LOCAL_CLIP_PREFIX}mid1`]
            )
        )
        assert.ok(mock.stores.local[`${types.LOCAL_CLIP_PREFIX}remote1`])
        assert.ok(mock.stores.local[`${types.LOCAL_CLIP_PREFIX}mid1`])

        // RPC-triggered pull also drains mid-pass external sync changes
        let injectRpcMidPass = true
        const prevSyncGet = mock.syncArea.get
        mock.syncArea.get = async (keys?: string | string[] | null) => {
            const res = await prevSyncGet(keys)
            if (keys == null && injectRpcMidPass) {
                injectRpcMidPass = false
                void mock.syncArea.set({
                    [`${types.SYNC_PREFIX}rpc_mid`]: {
                        id: "rpc_mid",
                        videoId: "dQw4w9WgXcQ",
                        title: "RPC Mid Pass",
                        videoTitle: "V",
                        start: 3,
                        end: 6,
                        createdAt: 400,
                        updatedAt: 400
                    }
                })
            }
            return res
        }
        const rpcRes = await mock.dispatchRuntimeMessage<{ ok: boolean }>({ action: "carpe:sync", op: "reconcile" })
        assert.equal(rpcRes.ok, true)
        assert.ok(mock.stores.local[`${types.LOCAL_CLIP_PREFIX}rpc_mid`])
        mock.syncArea.get = prevSyncGet

        // Identical clip re-save does not leak pendingOwnSyncMutations and swallow immediate external update
        await storage.upsertClip({
            id: "echo1",
            videoId: "dQw4w9WgXcQ",
            title: "No Echo",
            videoTitle: "V",
            start: 1,
            end: 5,
            createdAt: 100,
            updatedAt: 100
        })
        await mock.syncArea.set({
            [`${types.SYNC_PREFIX}echo1`]: {
                id: "echo1",
                videoId: "dQw4w9WgXcQ",
                title: "Updated Externally Immediately",
                videoTitle: "V",
                start: 1,
                end: 5,
                createdAt: 100,
                updatedAt: 888
            }
        })
        await waitFor(
            () =>
                (mock.stores.local[`${types.LOCAL_CLIP_PREFIX}echo1`] as types.Clip | undefined)?.title ===
                "Updated Externally Immediately"
        )
        assert.equal(
            (mock.stores.local[`${types.LOCAL_CLIP_PREFIX}echo1`] as types.Clip).title,
            "Updated Externally Immediately"
        )
    } finally {
        mock.syncArea.get = origSyncGet
    }
})

test("service worker scopes pending playback RPCs by target tabId", async () => {
    // carpe:consumePendingPlayback & carpe:setPendingPlayback RPCs scope by tabId
    await storage.setPendingPlayback({ clipId: "remote1", videoId: "dQw4w9WgXcQ", tabId: 77 })
    const wrongTab = await mock.dispatchRuntimeMessage<{ playback?: { clipId: string } | null }>(
        { action: "carpe:consumePendingPlayback", videoId: "dQw4w9WgXcQ" },
        88
    )
    assert.equal(wrongTab.playback, null)
    const rightTab = await mock.dispatchRuntimeMessage<{ playback?: { clipId: string } | null }>(
        { action: "carpe:consumePendingPlayback", videoId: "dQw4w9WgXcQ" },
        77
    )
    assert.equal(rightTab.playback?.clipId, "remote1")

    const setRpc = await mock.dispatchRuntimeMessage<{ ok: boolean }>(
        { action: "carpe:setPendingPlayback", playback: { clipId: "echo1", videoId: "dQw4w9WgXcQ", tabId: 99 } },
        0
    )
    assert.equal(setRpc.ok, true)
    const consumed99 = await mock.dispatchRuntimeMessage<{ playback?: { clipId: string } | null }>(
        { action: "carpe:consumePendingPlayback", videoId: "dQw4w9WgXcQ" },
        99
    )
    assert.equal(consumed99.playback?.clipId, "echo1")
})

test("service worker removes clip before writing remote tombstone when quota is full", async () => {
    // deleteClip removes clip from cloud BEFORE writing remote tombstone so full quota still accepts tombstone
    const origSet2 = mock.syncArea.set
    const origRemove2 = mock.syncArea.remove
    let quotaFullForDelete = true
    mock.syncArea.set = async (payload: Record<string, unknown>) => {
        if (quotaFullForDelete) {
            throw new Error("QUOTA_BYTES quota exceeded")
        }
        return origSet2(payload)
    }
    mock.syncArea.remove = async (keys: string | string[]) => {
        const res = await origRemove2(keys)
        quotaFullForDelete = false
        return res
    }
    try {
        await storage.deleteClip("echo1")
        assert.equal(mock.stores.sync[`${types.SYNC_PREFIX}echo1`], undefined)
        assert.ok((mock.stores.sync[types.SYNC_TOMBSTONES_KEY] as Record<string, number>)?.echo1)
    } finally {
        mock.syncArea.set = origSet2
        mock.syncArea.remove = origRemove2
    }
})

test("service worker schedules and deduplicates retry alarm on sync errors, clearing on recovery", async () => {
    // Triggering error writes schedules and deduplicates retry alarm, then recovers when cleared
    mock.createdAlarms.length = 0
    assert.equal(mock.activeAlarms.size, 0)
    mock.setSyncError(new Error("MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded"))
    await storage.upsertClip({
        id: "retry1",
        videoId: "dQw4w9WgXcQ",
        title: "Retry",
        videoTitle: "V",
        start: 1,
        end: 5,
        createdAt: 100,
        updatedAt: 100
    })
    await waitFor(() => mock.createdAlarms.length === 1)
    assert.equal(mock.createdAlarms.length, 1)
    assert.equal(mock.createdAlarms[0].name, "carpe-sync-retry")
    assert.equal(mock.createdAlarms[0].delayInMinutes, 1)
    assert.equal(mock.stores.local[types.SYNC_RETRY_STATE_KEY], 1)

    await storage.upsertClip({
        id: "retry2",
        videoId: "dQw4w9WgXcQ",
        title: "Retry 2",
        videoTitle: "V",
        start: 2,
        end: 6,
        createdAt: 200,
        updatedAt: 200
    })
    await flushEventTurns()
    assert.equal(mock.createdAlarms.length, 1)
    assert.equal(mock.stores.local[types.SYNC_RETRY_STATE_KEY], 1)

    mock.setSyncError(null)
    mock.activeAlarms.delete("carpe-sync-retry")
    mock.fireAlarm("carpe-sync-retry")
    await waitFor(async () => (await storage.getSyncStatus()).state === "healthy")

    assert.equal((await storage.getSyncStatus()).state, "healthy")
    assert.ok(mock.getClearedAlarmCount() >= 1)
    assert.equal(mock.stores.local[types.SYNC_RETRY_STATE_KEY], undefined)
})
