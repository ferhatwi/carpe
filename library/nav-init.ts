import { isSidebarCollapsed } from "./nav-state"

if (isSidebarCollapsed()) {
    document.documentElement.classList.add("nav-collapsed")
}
