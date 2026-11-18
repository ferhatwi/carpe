import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { extname, join, posix } from "node:path"

const DIST_DIR = "dist"

const RUNTIME_DIR_RULES = [
    { dir: "_locales", extensions: new Set([".json"]) },
    { dir: "icons", extensions: new Set([".png", ".svg"]) },
    { dir: "library", extensions: new Set([".html", ".css", ".js"]) },
    { dir: "src", extensions: new Set([".css", ".js"]) }
]

function collectFiles(dir, extensions) {
    const collected = []
    if (!existsSync(dir)) {
        return collected
    }

    for (const entry of readdirSync(dir).sort()) {
        const fullPath = join(dir, entry)
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
            collected.push(...collectFiles(fullPath, extensions))
        } else if (extensions.has(extname(entry).toLowerCase())) {
            collected.push(fullPath.split("\\").join(posix.sep))
        }
    }

    return collected
}

function getManifestRequiredPaths(manifest) {
    const required = new Set()

    for (const script of manifest.content_scripts ?? []) {
        for (const jsPath of script.js ?? []) {
            required.add(jsPath)
        }
        for (const cssPath of script.css ?? []) {
            required.add(cssPath)
        }
    }

    if (manifest.background?.service_worker) {
        required.add(manifest.background.service_worker)
    }

    if (manifest.options_ui?.page) {
        required.add(manifest.options_ui.page)
    }

    for (const iconPath of Object.values(manifest.icons ?? {})) {
        required.add(iconPath)
    }

    for (const iconPath of Object.values(manifest.action?.default_icon ?? {})) {
        required.add(iconPath)
    }

    return [...required]
}

function main() {
    const manifest = JSON.parse(readFileSync("manifest.json", "utf8"))
    const pkg = JSON.parse(readFileSync("package.json", "utf8"))

    if (manifest.version !== pkg.version) {
        throw new Error(
            `Version mismatch: manifest.json (${manifest.version}) !== package.json (${pkg.version}). Keep both in sync before releasing.`
        )
    }

    const files = ["manifest.json"]
    for (const rule of RUNTIME_DIR_RULES) {
        files.push(...collectFiles(rule.dir, rule.extensions))
    }

    const fileSet = new Set(files)
    const missing = getManifestRequiredPaths(manifest).filter((relPath) => !fileSet.has(relPath))
    if (missing.length > 0) {
        throw new Error(`Missing manifest-referenced build artifact(s): ${missing.join(", ")}. Run "pnpm build" first.`)
    }

    mkdirSync(DIST_DIR, { recursive: true })
    const archivePath = join(DIST_DIR, `carpe-v${manifest.version}.zip`)
    if (existsSync(archivePath)) {
        rmSync(archivePath)
    }

    try {
        execFileSync("zip", ["-q", "-X", archivePath, ...files], { stdio: "inherit" })
    } catch (err) {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
            throw new Error('The "zip" CLI tool was not found on PATH. Install Info-ZIP ("zip") and retry.')
        }
        throw err
    }

    const sizeKb = (statSync(archivePath).size / 1024).toFixed(1)
    console.log(`Packaged ${files.length} file(s) into ${archivePath} (${sizeKb} KB).`)
}

try {
    main()
} catch (err) {
    console.error("Release packaging failed:", err instanceof Error ? err.message : err)
    process.exit(1)
}
