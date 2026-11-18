# AI Assistant & Agent Guidelines

## Critical Architecture & Build Rules

1. **DO NOT edit or create any `.js` files directly:**

   - The git repository tracks only TypeScript (`.ts`) source files; no compiled JavaScript is committed to git.
   - All `.js` files (such as `src/content.js`, `src/service-worker.js`, `library/library.js`, etc.) are ephemeral, gitignored build artifacts generated from TypeScript by `build.mjs`.
   - Any manual changes to `.js` files will be overwritten on the next build.

2. **Always edit TypeScript source files (`.ts`):**

   - Make all changes in the corresponding `.ts` files inside `src/` and `library/`.
   - Update CSS in `src/content.css` and `library/styles/*.css`.

3. **Code Style & Formatting Rules:**
   - **Indentation:**
     - 4 spaces for TypeScript/JavaScript (`.ts`, `.js`) and CSS (`.css`).
     - 2 spaces for JSON (`.json`), YAML (`.yml`), HTML (`.html`), and Markdown (`.md`).
   - **Semicolons:** Omit semicolons (`semi: false`) in TypeScript/JavaScript.
   - **Quotes:** Use double quotes (`"`).
   - **Line Endings:** Unix LF (`\n`) strictly.
   - Maintain consistency with `.editorconfig` and `.prettierrc`.
