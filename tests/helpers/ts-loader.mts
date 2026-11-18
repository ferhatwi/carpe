import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

interface ResolveContext {
    parentURL?: string
}

type NextResolve = (specifier: string, context: ResolveContext) => unknown

export function resolve(specifier: string, context: ResolveContext, nextResolve: NextResolve): unknown {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
        const parentPath = fileURLToPath(context.parentURL)
        const base = path.resolve(path.dirname(parentPath), specifier)
        const isDir = fs.existsSync(base) && fs.statSync(base).isDirectory()
        if (!fs.existsSync(base) || isDir) {
            for (const ext of [".ts", ".mts"]) {
                if (fs.existsSync(`${base}${ext}`)) {
                    return { url: pathToFileURL(`${base}${ext}`).href, shortCircuit: true }
                }
            }
        }
        if (isDir) {
            for (const indexFile of ["index.ts", "index.mts"]) {
                const candidate = path.join(base, indexFile)
                if (fs.existsSync(candidate)) {
                    return { url: pathToFileURL(candidate).href, shortCircuit: true }
                }
            }
        }
    }
    return nextResolve(specifier, context)
}

export async function load(
    url: string,
    context: Record<string, unknown>,
    nextLoad: (u: string, c: Record<string, unknown>) => Promise<unknown>
): Promise<unknown> {
    if (url.endsWith(".svg")) {
        return {
            format: "module",
            shortCircuit: true,
            source: 'export default "<svg></svg>"\n'
        }
    }
    return nextLoad(url, context)
}
