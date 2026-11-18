import * as esbuild from "esbuild"
import { readdirSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"

const ENTRY_POINTS = [
    {
        entryPoints: ["src/content.ts"],
        outfile: "src/content.js",
        bundle: true,
        target: "es2022",
        format: "iife",
        loader: {
            ".svg": "text"
        },
        banner: {
            js: "// AUTO-GENERATED: DO NOT EDIT. Edit the .ts source files instead."
        }
    },
    {
        entryPoints: ["src/player-bridge.ts"],
        outfile: "src/player-bridge.js",
        bundle: true,
        target: "es2022",
        format: "iife",
        banner: {
            js: "// AUTO-GENERATED: DO NOT EDIT. Edit the .ts source files instead."
        }
    },
    {
        entryPoints: ["src/service-worker.ts"],
        outfile: "src/service-worker.js",
        bundle: true,
        target: "es2022",
        format: "iife",
        banner: {
            js: "// AUTO-GENERATED: DO NOT EDIT. Edit the .ts source files instead."
        }
    },
    {
        entryPoints: ["library/nav-init.ts"],
        outfile: "library/nav-init.js",
        bundle: true,
        target: "es2022",
        format: "iife",
        banner: {
            js: "// AUTO-GENERATED: DO NOT EDIT. Edit the .ts source files instead."
        }
    },
    {
        entryPoints: ["library/library.ts"],
        outfile: "library/library.js",
        bundle: true,
        target: "es2022",
        format: "iife",
        loader: {
            ".svg": "text"
        },
        banner: {
            js: "// AUTO-GENERATED: DO NOT EDIT. Edit the .ts source files instead."
        }
    },
    {
        entryPoints: ["library/settings.ts"],
        outfile: "library/settings.js",
        bundle: true,
        target: "es2022",
        format: "iife",
        loader: {
            ".svg": "text"
        },
        banner: {
            js: "// AUTO-GENERATED: DO NOT EDIT. Edit the .ts source files instead."
        }
    }
]

function findJsFiles(dir) {
    const files = []
    try {
        for (const item of readdirSync(dir)) {
            const fullPath = join(dir, item)
            if (statSync(fullPath).isDirectory()) {
                files.push(...findJsFiles(fullPath))
            } else if (item.endsWith(".js")) {
                files.push(fullPath)
            }
        }
    } catch {
        // Directory might not exist
    }
    return files
}

function cleanObsoleteJs() {
    const allowedOutfiles = new Set(ENTRY_POINTS.map((cfg) => join(cfg.outfile)))

    const allJsFiles = ["src", "library"].flatMap(findJsFiles)
    let cleanedCount = 0

    for (const file of allJsFiles) {
        if (!allowedOutfiles.has(file)) {
            unlinkSync(file)
            cleanedCount++
        }
    }

    if (cleanedCount > 0) {
        console.log(`Cleaned up ${cleanedCount} obsolete .js file(s).`)
    }
}

async function main() {
    cleanObsoleteJs()
    await Promise.all(ENTRY_POINTS.map((config) => esbuild.build(config)))
    console.log(`Successfully compiled ${ENTRY_POINTS.length} extension entry point(s).`)
}

main().catch((err) => {
    console.error("Build failed:", err)
    process.exit(1)
})
