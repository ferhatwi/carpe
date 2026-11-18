const colorCache = new Map<string, number>()

export function srgbToLinear(c: number): number {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

export function rgbToOklchHue(r: number, g: number, b: number): number {
    const lr = srgbToLinear(r)
    const lg = srgbToLinear(g)
    const lb = srgbToLinear(b)

    const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
    const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
    const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb

    const l_ = Math.cbrt(l)
    const m_ = Math.cbrt(m)
    const s_ = Math.cbrt(s)

    const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
    const b_ = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_

    let h = (Math.atan2(b_, a) * 180) / Math.PI
    if (h < 0) {
        h += 360
    }

    return h
}

export function extractAverageHueFromElement(img: HTMLImageElement): number | null {
    const src = img.src
    if (colorCache.has(src)) {
        return colorCache.get(src)!
    }
    // YouTube serves a 120x90 placeholder JPEG on 404
    if (img.naturalWidth <= 120) {
        return null
    }
    try {
        const canvas = document.createElement("canvas")
        canvas.width = 1
        canvas.height = 1
        const ctx = canvas.getContext("2d", {
            willReadFrequently: true
        })
        if (!ctx) {
            return null
        }
        const width = img.naturalWidth || img.width || 1
        const height = img.naturalHeight || img.height || 1
        // Sample center 70% to bypass letterboxing / pillarboxing
        const sx = width * 0.15
        const sy = height * 0.15
        const sw = width * 0.7
        const sh = height * 0.7
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 1, 1)
        const data = ctx.getImageData(0, 0, 1, 1).data
        const hue = rgbToOklchHue(data[0], data[1], data[2])
        colorCache.set(src, hue)
        return hue
    } catch {
        return null
    }
}

export function applyCardAmbientColor(card: HTMLElement, hue: number): void {
    card.style.setProperty("--card-h", `${hue.toFixed(1)}deg`)
}
