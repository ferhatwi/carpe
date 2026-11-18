import { SYNC_RETRY_STATE_KEY } from "../types"
import { createTaskQueue } from "../utils/async"
import { getSyncStatus } from "./syncState"

export const SYNC_RETRY_ALARM = "carpe-sync-retry"
export const RETRY_DELAY_MINUTES = [1, 2, 4, 8, 15] as const

const enqueueAlarmReconcile = createTaskQueue()

export async function clearRetryAlarm(): Promise<void> {
    await chrome.alarms.clear(SYNC_RETRY_ALARM)
    await chrome.storage.local.remove(SYNC_RETRY_STATE_KEY)
}

export async function scheduleRetryAlarm(): Promise<void> {
    const existing = await chrome.alarms.get(SYNC_RETRY_ALARM)
    if (existing) {
        return
    }

    const data = await chrome.storage.local.get(SYNC_RETRY_STATE_KEY)
    const attempts = Math.max(0, Number(data[SYNC_RETRY_STATE_KEY]) || 0)
    if (attempts >= RETRY_DELAY_MINUTES.length) {
        return
    }

    const delayInMinutes = RETRY_DELAY_MINUTES[attempts]
    await chrome.storage.local.set({ [SYNC_RETRY_STATE_KEY]: attempts + 1 })
    await chrome.alarms.create(SYNC_RETRY_ALARM, { delayInMinutes })
}

export async function reconcileRetryAlarm(): Promise<void> {
    await enqueueAlarmReconcile(async () => {
        const status = await getSyncStatus()
        if (status.state === "error") {
            await scheduleRetryAlarm()
        } else {
            await clearRetryAlarm()
        }
    })
}
