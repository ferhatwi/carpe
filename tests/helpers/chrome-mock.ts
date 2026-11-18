export type StorageListener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void

export interface SimpleStorageArea {
    get: (keys?: string | string[] | null) => Promise<Record<string, unknown>>
    set: (items: Record<string, unknown>) => Promise<void>
    remove: (keys: string | string[]) => Promise<void>
}

export interface StorageMockControls {
    stores: {
        local: Record<string, unknown>
        sync: Record<string, unknown>
    }
    localArea: SimpleStorageArea
    syncArea: SimpleStorageArea
    createdAlarms: { name: string; delayInMinutes?: number }[]
    activeAlarms: Map<string, { name: string; delayInMinutes?: number }>
    alarmListeners: Set<(alarm: { name: string }) => void>
    messageListeners: Set<
        (message: unknown, sender: { tab?: { id?: number } }, sendResponse: (res: unknown) => void) => unknown
    >
    setSyncError: (err: Error | null) => void
    setSendMessage: (fn?: (msg: unknown) => Promise<unknown>) => void
    getClearedAlarmCount: () => number
    dispatchRuntimeMessage: <T = unknown>(msg: unknown, tabId?: number) => Promise<T>
    fireAlarm: (name: string) => void
}

export interface StorageMockOptions {
    withRuntimeListeners?: boolean
    manifestVersion?: string
}

export function createChromeMock(options: StorageMockOptions = {}): StorageMockControls {
    const stores = {
        local: {} as Record<string, unknown>,
        sync: {} as Record<string, unknown>
    }
    let syncError: Error | null = null
    const listeners = new Set<StorageListener>()
    const createdAlarms: { name: string; delayInMinutes?: number }[] = []
    const activeAlarms = new Map<string, { name: string; delayInMinutes?: number }>()
    const alarmListeners = new Set<(alarm: { name: string }) => void>()
    const messageListeners = new Set<
        (message: unknown, sender: { tab?: { id?: number } }, sendResponse: (res: unknown) => void) => unknown
    >()
    let clearedCount = 0

    function makeArea(name: "local" | "sync") {
        return {
            async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
                if (name === "sync" && syncError) throw syncError
                if (keys == null) return structuredClone(stores[name])
                if (typeof keys === "string") {
                    return keys in stores[name] ? { [keys]: structuredClone(stores[name][keys]) } : {}
                }
                if (Array.isArray(keys)) {
                    const out: Record<string, unknown> = {}
                    for (const k of keys) {
                        if (k in stores[name]) out[k] = structuredClone(stores[name][k])
                    }
                    return out
                }
                return {}
            },
            async set(items: Record<string, unknown>): Promise<void> {
                if (name === "sync" && syncError) throw syncError
                const changes: Record<string, chrome.storage.StorageChange> = {}
                for (const [k, v] of Object.entries(items)) {
                    changes[k] = { oldValue: structuredClone(stores[name][k]), newValue: structuredClone(v) }
                    stores[name][k] = structuredClone(v)
                }
                for (const fn of listeners) fn(changes, name)
            },
            async remove(keys: string | string[]): Promise<void> {
                if (name === "sync" && syncError) throw syncError
                const list = Array.isArray(keys) ? keys : [keys]
                const changes: Record<string, chrome.storage.StorageChange> = {}
                for (const k of list) {
                    if (k in stores[name]) {
                        changes[k] = { oldValue: structuredClone(stores[name][k]) }
                        delete stores[name][k]
                    }
                }
                if (Object.keys(changes).length) {
                    for (const fn of listeners) fn(changes, name)
                }
            }
        }
    }

    const localArea = makeArea("local")
    const syncArea = makeArea("sync")

    const runtimeBase: Record<string, unknown> = {
        getManifest: () => ({ version: options.manifestVersion ?? "1.2.3" }),
        getURL: (p: string) => `chrome-extension://test/${p}`
    }

    const runtimeObj: Record<string, unknown> = options.withRuntimeListeners
        ? {
              ...runtimeBase,
              id: "test-ext-id",
              onInstalled: { addListener: () => {} },
              onStartup: { addListener: () => {} },
              onMessage: {
                  addListener: (
                      fn: (
                          message: unknown,
                          sender: { tab?: { id?: number } },
                          sendResponse: (res: unknown) => void
                      ) => unknown
                  ) => messageListeners.add(fn)
              }
          }
        : runtimeBase

    const chromeStub: Record<string, unknown> = {
        storage: {
            local: localArea,
            sync: syncArea,
            onChanged: {
                addListener: (fn: StorageListener) => listeners.add(fn),
                removeListener: (fn: StorageListener) => listeners.delete(fn)
            }
        },
        runtime: runtimeObj,
        i18n: {
            getUILanguage: () => "en",
            getMessage: (k: string) => k
        }
    }

    if (options.withRuntimeListeners) {
        chromeStub.alarms = {
            get: async (name: string) => activeAlarms.get(name),
            create: async (name: string, info: { delayInMinutes?: number }) => {
                const alarm = { name, ...info }
                createdAlarms.push(alarm)
                activeAlarms.set(name, alarm)
            },
            clear: async (name?: string) => {
                clearedCount++
                if (name) activeAlarms.delete(name)
                else activeAlarms.clear()
                return true
            },
            onAlarm: { addListener: (fn: (alarm: { name: string }) => void) => alarmListeners.add(fn) }
        }
        chromeStub.tabs = {
            create: () => {},
            onRemoved: { addListener: () => {} }
        }
        chromeStub.action = { onClicked: { addListener: () => {} } }
    }

    ;(globalThis as unknown as Record<string, unknown>).chrome = chromeStub

    return {
        stores,
        localArea,
        syncArea,
        createdAlarms,
        activeAlarms,
        alarmListeners,
        messageListeners,
        setSyncError: (err) => {
            syncError = err
        },
        setSendMessage: (fn) => {
            if (fn) {
                runtimeObj.id = "test-ext-id"
                runtimeObj.sendMessage = fn
            } else {
                delete runtimeObj.sendMessage
            }
        },
        getClearedAlarmCount: () => clearedCount,
        dispatchRuntimeMessage: <T = unknown>(msg: unknown, tabId?: number) =>
            new Promise<T>((resolve) => {
                const sender = tabId === undefined ? {} : { tab: { id: tabId } }
                for (const fn of messageListeners) {
                    fn(msg, sender, (res) => resolve(res as T))
                }
            }),
        fireAlarm: (name: string) => {
            for (const fn of alarmListeners) {
                fn({ name })
            }
        }
    }
}
