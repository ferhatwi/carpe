const SIDEBAR_COLLAPSED_KEY = "sidebar-collapsed"

/**
 * Reads the persisted collapsed state of the desktop navigation rail.
 */
export function isSidebarCollapsed(): boolean {
    try {
        return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true"
    } catch {
        return false
    }
}

/**
 * Persists the collapsed state of the desktop navigation rail.
 */
export function saveSidebarCollapsed(collapsed: boolean): void {
    try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
    } catch {
        // Ignore storage errors in restricted contexts
    }
}
