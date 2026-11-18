export interface ElementOptions {
    id?: string
    className?: string
    hidden?: boolean
    ariaLabel?: string
    ariaHidden?: string
    ariaPressed?: string
    role?: string
    type?: string
    title?: string
    svgIcon?: string
    textContent?: string
    attributes?: Record<string, string>
    children?: (Node | string)[]
}

/**
 * Parses a trusted SVG markup string into a DOM SVG element without using innerHTML.
 */
export function parseSvgElement(svgMarkup: string): SVGElement | null {
    const parsed = new DOMParser().parseFromString(svgMarkup.trim(), "image/svg+xml")
    const root = parsed.documentElement
    if (!root || !(root instanceof SVGElement) || parsed.querySelector("parsererror")) {
        return null
    }
    return document.importNode(root, true)
}

/**
 * Declarative DOM element factory to reduce repetitive createElement boilerplate.
 */
export function createElement<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options: ElementOptions = {}
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag)

    if (options.id) el.id = options.id
    if (options.className) el.className = options.className
    if (options.hidden !== undefined) el.hidden = options.hidden
    if (options.ariaLabel) el.setAttribute("aria-label", options.ariaLabel)
    if (options.ariaHidden) el.setAttribute("aria-hidden", options.ariaHidden)
    if (options.ariaPressed) el.setAttribute("aria-pressed", options.ariaPressed)
    if (options.role) el.setAttribute("role", options.role)
    if (options.type) {
        el.setAttribute("type", options.type)
    }
    if (options.title) el.title = options.title
    if (options.svgIcon) {
        const svg = parseSvgElement(options.svgIcon)
        if (svg) {
            el.appendChild(svg)
        }
    }
    if (options.textContent) el.textContent = options.textContent

    if (options.attributes) {
        for (const [key, value] of Object.entries(options.attributes)) {
            el.setAttribute(key, value)
        }
    }

    if (options.children) {
        el.append(...options.children)
    }

    return el
}
