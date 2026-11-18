import { MessageKey, t } from "../src/i18n/index"
import { createElement } from "../src/utils/dom"
import { isSidebarCollapsed, saveSidebarCollapsed } from "./nav-state"
import menuIcon from "../icons/menu_thin.svg"

export type AppShellPage = "clips" | "settings"

interface NavItemConfig {
    id: AppShellPage
    href: string
    labelKey: MessageKey
    activeIcon: string
    inactiveIcon: string
}

const NAV_ITEMS: NavItemConfig[] = [
    {
        id: "clips",
        href: "index.html",
        labelKey: "navClips",
        activeIcon: "/icons/movie_filled.svg",
        inactiveIcon: "/icons/movie_outlined.svg"
    },
    {
        id: "settings",
        href: "settings.html",
        labelKey: "navSettings",
        activeIcon: "/icons/settings_filled.svg",
        inactiveIcon: "/icons/settings_outlined.svg"
    }
]

/**
 * Initiates a browser file download from an in-memory string.
 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Reads a File as UTF-8 text using a Promise wrapper around FileReader.
 */
export function readTextFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ""))
        reader.onerror = () => reject(new Error("FILE_READ_ERROR"))
        reader.readAsText(file)
    })
}

function updateSidebarToggleA11y(sidebarToggleBtn: HTMLButtonElement, collapsed: boolean): void {
    sidebarToggleBtn.setAttribute("aria-expanded", String(!collapsed))
    sidebarToggleBtn.setAttribute("aria-label", t(collapsed ? "ariaOpenNavMenu" : "ariaCloseNavMenu"))
}

/**
 * Wires the desktop sidebar collapse toggle button and persists state.
 */
function setupSidebarToggle(sidebarToggleBtn: HTMLButtonElement): void {
    sidebarToggleBtn.addEventListener("click", () => {
        const collapsed = document.documentElement.classList.toggle("nav-collapsed")
        updateSidebarToggleA11y(sidebarToggleBtn, collapsed)
        saveSidebarCollapsed(collapsed)
    })
}

/**
 * Mounts the shared sticky header and responsive nav (bottom bar on mobile, collapsible rail on tablet/desktop).
 */
export function mountAppShell(activePage: AppShellPage): void {
    if (isSidebarCollapsed()) {
        document.documentElement.classList.add("nav-collapsed")
    }

    const collapsed = document.documentElement.classList.contains("nav-collapsed")

    const sidebarToggleBtn = createElement("button", {
        id: "sidebar-toggle",
        className: "btn-icon",
        type: "button",
        attributes: {
            "aria-controls": "main-nav"
        },
        svgIcon: menuIcon
    })
    updateSidebarToggleA11y(sidebarToggleBtn, collapsed)

    const brandLink = createElement("a", {
        className: "header-brand",
        attributes: { href: "index.html", title: "Carpe" },
        children: [
            createElement("img", {
                attributes: { src: "/icons/icon.svg", alt: "", width: "30", height: "24", "aria-hidden": "true" }
            }),
            createElement("span", { textContent: "Carpe" })
        ]
    })

    const header = createElement("header", {
        children: [
            createElement("div", {
                className: "header-left",
                children: [sidebarToggleBtn, brandLink]
            })
        ]
    })

    const navLinks = NAV_ITEMS.map((item) => {
        const isActive = item.id === activePage
        const icon = createElement("span", { className: "icon mono" })
        icon.style.setProperty("--icon-url", `url("${isActive ? item.activeIcon : item.inactiveIcon}")`)

        return createElement("a", {
            className: isActive ? "nav-item active" : "nav-item",
            attributes: isActive ? { href: item.href, "aria-current": "page" } : { href: item.href },
            children: [icon, createElement("span", { className: "nav-label", textContent: t(item.labelKey) })]
        })
    })

    const nav = createElement("nav", {
        id: "main-nav",
        ariaLabel: t("ariaMainNav"),
        children: navLinks
    })

    const main = document.querySelector<HTMLElement>("main")
    if (main && main.parentNode) {
        main.parentNode.insertBefore(header, main)
        main.parentNode.insertBefore(nav, main)
    } else {
        document.body.prepend(header, nav)
    }

    setupSidebarToggle(sidebarToggleBtn)
}
