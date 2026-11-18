import { CURRENT_SCHEMA_VERSION, SCHEMA_VERSION_KEY } from "../types"

interface Migration {
    version: number
    description: string
    migrate: () => Promise<void>
}

/**
 * Sequential storage migrations list.
 * Future migrations will be added here sequentially starting from version 2.
 */
const migrations: Migration[] = []

/**
 * Automatically runs any pending schema migrations up to CURRENT_SCHEMA_VERSION.
 * Invoked on install/update and lazily across service-worker sync entrypoints via ensureMigrationsReady().
 */
export async function runStorageMigrations(): Promise<void> {
    const data = await chrome.storage.local.get(SCHEMA_VERSION_KEY)
    const rawVersion = data[SCHEMA_VERSION_KEY]

    // Fresh install: key does not exist yet in storage
    if (rawVersion === undefined) {
        await chrome.storage.local.set({
            [SCHEMA_VERSION_KEY]: CURRENT_SCHEMA_VERSION
        })
        return
    }

    let currentVersion = Number(rawVersion) || 0
    if (currentVersion >= CURRENT_SCHEMA_VERSION) {
        return
    }

    for (const step of migrations) {
        if (step.version > currentVersion) {
            console.log(`[Carpe Migration] Running v${step.version}: ${step.description}`)
            await step.migrate()
            currentVersion = step.version
            await chrome.storage.local.set({
                [SCHEMA_VERSION_KEY]: currentVersion
            })
        }
    }
}
