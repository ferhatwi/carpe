# Contributing to Carpe

Thank you for your interest in contributing to Carpe! Here are the development guidelines to keep contributions clean, maintainable, and reliable.

---

## Architecture & Build Guidelines

1. **Source Code is 100% TypeScript (`.ts`):**
   - The git repository contains only TypeScript (`.ts`) and CSS (`.css`) source files; no `.js` files are committed.
   - When you run `pnpm build` locally, `build.mjs` generates JavaScript bundles directly in-tree (`src/content.js`, `src/service-worker.js`, `library/library.js`, etc.) so Chrome can load the unpacked extension.
   - These generated `.js` files are gitignored and automatically overwritten on every build. Never edit `.js` files directly; always make changes in the corresponding `.ts` source files.

2. **Always edit `.ts` source files:**
   - TypeScript sources reside in `src/` and `library/`.
   - Styles reside in `src/content.css` and `library/styles/*.css`.

3. **Code Style & Formatting:**
   - **Indentation:**
     - 4 spaces for TypeScript/JavaScript (`.ts`, `.js`) and CSS (`.css`).
     - 2 spaces for JSON (`.json`), YAML (`.yml`), HTML (`.html`), and Markdown (`.md`).
   - **Semicolons:** Omitted (`semi: false`) in TypeScript/JavaScript.
   - **Quotes:** Double quotes (`"`).
   - **Line Endings:** Unix LF (`\n`) strictly.
   - Run `pnpm format` before committing.

---

## Testing & Quality Assurance

Before submitting a Pull Request, run the full verification suite:

```bash
pnpm check
```

This runs:

1. `pnpm type-check` — Strict TypeScript checking (`tsc --noEmit`).
2. `pnpm format:check` — Prettier verification.
3. `pnpm test` — Unit test suite via Node's native test runner (`node --test`).
4. `pnpm build` — Multi-entry point bundling via esbuild.

All four steps must pass cleanly with zero errors.

---

## AI Assistant / Agent Maintainers

If you use AI coding assistants to develop or review patches, please refer to [AGENTS.md](AGENTS.md) for critical workspace constraints.
