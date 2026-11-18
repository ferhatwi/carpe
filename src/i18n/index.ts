import type enMessages from "../../_locales/en/messages.json"
import { isExtensionContextValid } from "../utils/extension"

export type MessageKey = keyof typeof enMessages

const RTL_LANGS = new Set(["ar", "arc", "dv", "fa", "ha", "he", "iw", "khw", "ks", "ku", "ps", "sd", "ug", "ur", "yi"])

/**
 * Returns the browser UI locale tag used by chrome.i18n.
 */
export function getUiLocale(): string {
    if (isExtensionContextValid() && typeof chrome.i18n?.getUILanguage === "function") {
        try {
            return (chrome.i18n.getUILanguage() || "en").replace(/_/g, "-")
        } catch {
            // Fall through to navigator.language
        }
    }
    return (typeof navigator !== "undefined" ? navigator.language || "en" : "en").replace(/_/g, "-")
}

/**
 * Checks whether a BCP-47 locale tag uses right-to-left text direction.
 */
export function isRtlLocale(locale: string = getUiLocale()): boolean {
    const base = locale.split(/[-_]/)[0]?.toLowerCase() ?? ""
    return RTL_LANGS.has(base)
}

/**
 * Resolves a localized string from chrome.i18n with compile-time key checking.
 */
export function t(key: MessageKey, substitutions?: string | string[]): string {
    if (isExtensionContextValid() && typeof chrome.i18n?.getMessage === "function") {
        try {
            const message = chrome.i18n.getMessage(key, substitutions)
            if (message) {
                return message
            }
        } catch {
            // Fall through to key fallback when context is invalidated
        }
    }
    return key
}

/**
 * Formats a clip count using the active locale's plural rules.
 */
export function formatClipCount(count: number): string {
    const locale = getUiLocale()
    let rule: Intl.LDMLPluralRule = "other"
    try {
        rule = new Intl.PluralRules(locale).select(count)
    } catch {
        rule = count === 1 ? "one" : "other"
    }
    const key: MessageKey = rule === "one" ? "clipCountOne" : "clipCountOther"
    return t(key, [String(count)])
}

/**
 * Applies data-i18n text and data-i18n-attr attribute translations within a DOM subtree.
 */
export function translateDocument(root: ParentNode = document): void {
    root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
        const key = el.dataset.i18n as MessageKey | undefined
        if (key) {
            el.textContent = t(key)
        }
    })

    root.querySelectorAll<HTMLElement>("[data-i18n-attr]").forEach((el) => {
        const spec = el.dataset.i18nAttr
        if (!spec) {
            return
        }
        for (const pair of spec.split(",")) {
            const [attr, key] = pair.split(":").map((part) => part.trim())
            if (attr && key) {
                el.setAttribute(attr, t(key as MessageKey))
            }
        }
    })

    root.querySelectorAll("template").forEach((tpl) => {
        translateDocument(tpl.content)
    })
}

/**
 * Synchronizes html lang/dir, document title, and static DOM text for an extension page.
 */
export function initPageI18n(titleKey: MessageKey): void {
    const locale = getUiLocale()
    document.documentElement.lang = locale
    document.documentElement.dir = isRtlLocale(locale) ? "rtl" : "ltr"
    document.title = t(titleKey)
    translateDocument(document)
}
