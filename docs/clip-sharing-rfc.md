# Carpe: Future Clip Sharing RFC (Request for Comments)

## 1. Context & Motivation

Currently, Carpe operates as a local-first **Personal Vault**. Clips are stored on the user's device and buffered to private Chrome Cloud Sync (`chrome.storage.sync`).

When expanding into **Clip Sharing and a Collaborative Ecosystem**, we must solve:

1. How shared clips behave for users **with** the Carpe extension installed.
2. How shared clips behave for recipients **without** the extension (standard YouTube playback).
3. How to avoid anonymous, title-less ghost states while preserving clip metadata (title, tags, author, exact timestamps).

---

## 2. The Recipient Experience

```
User Shares Link
       │
       ▼
[ Does recipient have Carpe? ]
  ├── NO  ──► Standard YouTube watch page. URL `&t=45s` seeks to start time.
  │           (Optional: subtle web banner / web player overlay if using custom domain)
  │
  └── YES ──► In-Player Shared Clip Banner appears above YouTube timeline:
              "Shared Clip: 'Insane Solo' (0:45 → 1:20) by @alice"
              [ Save to Vault ]  [ Play Once ]  [ Dismiss ]
```

---

## 3. Data Transfer Mechanisms

### Option A: URL Fragment Payload (Zero Backend / Serverless)

Encode clip metadata directly inside the URL hash or query string.

- **URL Structure**:
  ```
  https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=45s#clip=eyAidGl0bGUiOiAiSW5zYW5lIFNvbG8iLCAic3RhcnQiOiA0NSwgImVuZCI6IDkwIH0=
  ```
  _(Payload is Base64-encoded JSON or URL-safe CBOR)_
- **Pros**:
  - Requires **zero cloud servers**, zero databases, and zero hosting costs.
  - 100% decentralized and privacy-preserving.
  - Standard YouTube ignores URL hash fragments (`#...`), so YouTube playback never breaks.
- **Cons**:
  - URLs can become long if notes/descriptions are attached.

---

### Option B: Shortlinks via Dedicated Domain (Web Gateway)

Use a vanity link service (e.g. `carpe.link/c/<id>` or `vault.clip/<id>`).

- **Flow**:
  1. User clicks **Share** -> Carpe uploads lightweight metadata JSON to Cloudflare Workers KV / Firebase / Supabase.
  2. Generates short link: `https://carpe.link/c/7f8a9d`.
  3. Clicking link:
     - **On desktop with extension**: Extension intercepts or gateway redirects to YouTube with deep-link payload.
     - **Without extension**: Landing page with embedded YouTube iframe, showing clip card and a button _"Install Carpe to save this clip"_.
- **Pros**:
  - Great viral loop / extension acquisition.
  - Clean, short URLs easy to share in Discord, Twitter/X, and Reddit.
- **Cons**:
  - Requires maintaining a light web service and database.

---

## 4. Proposed Data Model for Shared Clip Payload

```typescript
export interface SharedClipPayload {
  version: 1
  videoId: string
  title: string
  start: number
  end: number
  author?: string
  notes?: string
  sharedAt: number
}
```

---

## 5. Clean Import Flow (Making Shared Clips Explicit)

Instead of silently treating shared links as anonymous "previews", the extension will treat them as an **Incoming Shared Clip**:

1. A distinct banner appears over the YouTube player:
   > 🎬 **Incoming Clip:** _"Guitar Solo"_ (0:45 → 1:20)
   > `[ Save to Vault ]` `[ Loop Preview ]`
2. If the user clicks **Save to Vault**:
   - The clip is persisted into their local `readClips()`.
   - It receives an ID in their local database.
   - It appears in their shelf and Vault grid.
3. If dismissed, playback returns to ordinary YouTube mode.

---

## 6. Recommendations & Roadmap

For the current milestone:

- **Phase 1 (Current)**: Keep Carpe strictly ID-driven (`&clipId=<id>`) for shareable and exported links.
- **Phase 2 (Future)**: Implement Option A (URL hash payload) for zero-server P2P clip sharing with an explicit "Save to Vault" banner.
- **Phase 3 (Ecosystem)**: Introduce vanity web gateway for rich social embeds and cross-platform viewing.
