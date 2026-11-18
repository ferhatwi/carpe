# Carpe: In-Library Hover Video Playback RFC (Request for Comments)

## 1. Executive Summary

This RFC explores adding **hover video playback** to the Carpe Library (Vault) grid—mirroring the preview behavior on YouTube's homepage and subscription feed. When a user hovers their cursor over a clip card for a sustained period, the thumbnail is seamlessly replaced by a muted preview playing the exact clip segment (`start` to `end`).

---

## 2. Goals & User Experience

### 2.1 Goals

- Allow users to quickly preview saved clips in the Vault without opening a new tab or leaving the Library.
- Respect clip boundaries: playback should begin at `clip.start` and loop or pause at `clip.end`.
- Maintain zero layout shift: card dimensions and text do not jump or resize.
- Maintain lightweight performance: avoid spawning network requests or media decoders on casual mouse sweeps.

### 2.2 User Experience Flow

1. **Pointer Enter**: Pointer moves over `.clip-card`. The ambient envelope immediately expands and tints based on the thumbnail's average color.
2. **Hover Intent Delay (400–500ms)**: A timer waits to confirm the user intentionally stopped on this card rather than casually sweeping across the grid.
3. **Player Mount**: An embedded YouTube player mounts over the thumbnail, muted, starting at `clip.start`.
4. **Range Looping**: The player loops between `clip.start` and `clip.end`.
5. **Pointer Leave**: The iframe is immediately unmounted and destroyed from the DOM, releasing hardware decoders and video memory. The thumbnail returns instantly.
6. **Card Click**: Clicking the card retains its existing behavior—opening the full YouTube watch page in an active tab.

---

## 3. Technical Architecture & Feasibility

### Approach A: Embedded Iframe via YouTube IFrame API (Recommended)

Extension pages (`chrome-extension://...`) can embed YouTube's standard embed iframe:

```html
<iframe
  src="https://www.youtube.com/embed/{videoId}?start={start}&end={end}&autoplay=1&mute=1&controls=0&modestbranding=1&rel=0"
  allow="autoplay; encrypted-media"
  tabindex="-1"
  aria-hidden="true"
></iframe>
```

#### Why Approach A is Preferred:

- **100% YouTube TOS Compliant**: Embeds are official and supported by YouTube.
- **Zero Reverse-Engineering**: Bypasses the need to decrypt DASH audio/video streams or maintain fragile video scrapers.
- **Native Adaptive Streaming**: YouTube automatically serves appropriate resolution (360p/480p) based on network conditions and thumbnail dimensions.
- **Strict Start/End Enforcement**: The embed parameters `start={start}&end={end}` natively constrain playback.

#### Challenges & Mitigations:

- **Cold Boot Latency**: YouTube embed iframes take ~300–600ms to initialize.
  - _Mitigation_: The static thumbnail stays visible underneath while the iframe loads opacity: 0 -> 1.
- **Memory Consumption**: Multiple active iframes will consume high RAM.
  - _Mitigation_: Only **one** preview iframe may be active across the entire Library at any given moment. Hovering away immediately destroys the active iframe.
- **Network Bandwidth**:
  - _Mitigation_: The 500ms hover intent gate ensures iframes only load on intentional focus.

---

### Approach B: Direct HTML5 `<video>` via Stream Decryption (Not Recommended)

Directly playing `.webm` or `.mp4` video streams inside a native `<video>` tag by resolving streaming manifests.

#### Why Approach B is Discarded:

- YouTube uses dynamic chunked DASH manifests with ciphered audio/video signatures that break whenever YouTube updates player internals.
- Requires either bundling heavy stream decoders (e.g. yt-dlp backends) or running an external proxy server, violating Carpe's lightweight, serverless design.

---

## 4. Proposed Implementation Architecture

### 4.1 State Management (`PreviewController`)

A single singleton controller manages hover state across all cards in `library.ts`:

```typescript
class CardPreviewController {
  private activeIframe: HTMLIFrameElement | null = null
  private hoverTimer: number | null = null
  private currentCard: HTMLElement | null = null

  public onCardMouseEnter(card: HTMLElement, clip: Clip): void {
    this.clearTimer()
    this.hoverTimer = window.setTimeout(() => {
      this.mountPreview(card, clip)
    }, 450)
  }

  public onCardMouseLeave(card: HTMLElement): void {
    this.clearTimer()
    if (this.currentCard === card) {
      this.unmountPreview()
    }
  }

  private mountPreview(card: HTMLElement, clip: Clip): void {
    this.unmountPreview() // Ensure single player instance
    const wrapper = card.querySelector(".clip-thumbnail-wrapper")
    if (!wrapper) return

    const iframe = document.createElement("iframe")
    iframe.className = "clip-hover-preview"
    iframe.src = `https://www.youtube.com/embed/${clip.videoId}?start=${Math.floor(clip.start)}&end=${Math.ceil(clip.end)}&autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&playsinline=1`
    iframe.allow = "autoplay; encrypted-media"
    iframe.tabIndex = -1
    iframe.setAttribute("aria-hidden", "true")

    wrapper.appendChild(iframe)
    this.activeIframe = iframe
    this.currentCard = card
  }

  public unmountPreview(): void {
    if (this.activeIframe) {
      this.activeIframe.remove()
      this.activeIframe = null
    }
    this.currentCard = null
  }

  private clearTimer(): void {
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer)
      this.hoverTimer = null
    }
  }
}
```

### 4.2 Styling & Transition (`cards.css`)

```css
.clip-hover-preview {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
  border-radius: inherit;
  pointer-events: none; /* Allows card click to bubble up */
  z-index: 1;
}
```

---

## 5. Security & Manifest Considerations

1. **Content Security Policy (CSP)**:
   Chrome extension pages in Manifest V3 require `frame-src https://www.youtube.com` if not already permitted. If required, `content_security_policy` in `manifest.json` will be updated:
   ```json
   "content_security_policy": {
     "extension_pages": "script-src 'self'; frame-src https://www.youtube.com;"
   }
   ```
2. **Permissions**:
   `host_permissions` already includes `https://www.youtube.com/*`, which covers embed iframe origins.

---

## 6. Recommendations & Staging

- **Phase 1 (Implemented)**: Ambient thumbnail color extraction and expanding envelope design matching YouTube's card aesthetics.
- **Phase 2 (Next Milestone)**: Add settings toggle: `[x] Enable video preview on hover` (default: ON on desktop, disabled on mobile).
- **Phase 3**: Implement single-instance `CardPreviewController` with 450ms hover intent gate and auto-looping between clip start/end.
