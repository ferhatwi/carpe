import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { createTaskQueue } from "../src/utils/async"
import { formatClipTime, formatClipTimeWithFrame, formatLibraryTime } from "../src/utils/time"
import { normalizeTitle, sanitizeTitle } from "../src/utils/youtube"

const repoRoot = path.resolve(import.meta.dirname, "..")

test("time formatting preserves clip and library behavior", () => {
    assert.equal(formatClipTime(65), "1:05")
    assert.equal(formatLibraryTime(65), "01:05")
    assert.equal(formatClipTime(3665), "1:01:05")
    assert.equal(formatLibraryTime(3665), "01:01:05")
})

test("formatClipTimeWithFrame formats frame numbers across frame rates and handles rollovers", () => {
    assert.deepEqual(formatClipTimeWithFrame(65, 1 / 30), { time: "1:05", frame: "00" })
    assert.deepEqual(formatClipTimeWithFrame(65.5, 1 / 30), { time: "1:05", frame: "15" })
    assert.deepEqual(formatClipTimeWithFrame(65.5, 1 / 60), { time: "1:05", frame: "30" })
    assert.deepEqual(formatClipTimeWithFrame(65.5, 1 / 24), { time: "1:05", frame: "12" })

    // Floating-point nudge accumulation right at second boundary rolls over cleanly without ever hitting :30
    assert.deepEqual(formatClipTimeWithFrame(10 + 29 * (1 / 30), 1 / 30), { time: "0:10", frame: "29" })
    assert.deepEqual(formatClipTimeWithFrame(10 + 30 * (1 / 30) - 1e-9, 1 / 30), { time: "0:11", frame: "00" })
    assert.deepEqual(formatClipTimeWithFrame(3665 + 14 / 60, 1 / 60), { time: "1:01:05", frame: "14" })

    // Edge cases: negative seconds and invalid frameDuration fall back safely
    assert.deepEqual(formatClipTimeWithFrame(-5, 1 / 30), { time: "0:00", frame: "00" })
    assert.deepEqual(formatClipTimeWithFrame(1.5, 0), { time: "0:01", frame: "15" })
})

test("normalizeTitle preserves intentional prefixes/suffixes while sanitizeTitle cleans DOM titles", () => {
    assert.equal(normalizeTitle("  (1)   Intro - YouTube  "), "(1) Intro - YouTube")
    assert.equal(sanitizeTitle("(12+) Cool Video - YouTube"), "Cool Video")
    assert.equal(sanitizeTitle("  (3)   Demo   Clip  "), "Demo Clip")
})

test("locale files keep matching keys and placeholders", () => {
    const en = JSON.parse(fs.readFileSync(path.join(repoRoot, "_locales/en/messages.json"), "utf8")) as Record<
        string,
        { message: string; placeholders?: Record<string, unknown> }
    >
    const tr = JSON.parse(fs.readFileSync(path.join(repoRoot, "_locales/tr/messages.json"), "utf8")) as Record<
        string,
        { message: string; placeholders?: Record<string, unknown> }
    >

    assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort())
    for (const key of Object.keys(en)) {
        const enPlaceholders = Object.keys(en[key].placeholders ?? {}).sort()
        const trPlaceholders = Object.keys(tr[key].placeholders ?? {}).sort()
        assert.deepEqual(trPlaceholders, enPlaceholders, `Placeholder mismatch for locale key: ${key}`)
    }
})

test("createTaskQueue serializes async tasks sequentially", async () => {
    const enqueue = createTaskQueue()
    const log: number[] = []

    const t1 = enqueue(async () => {
        await new Promise((r) => setTimeout(r, 10))
        log.push(1)
        return "first"
    })
    const t2 = enqueue(async () => {
        log.push(2)
        return "second"
    })

    const [r1, r2] = await Promise.all([t1, t2])
    assert.equal(r1, "first")
    assert.equal(r2, "second")
    assert.deepEqual(log, [1, 2])
})
