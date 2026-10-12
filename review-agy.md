# 🃏 Sprint Planning Poker — Comprehensive Codebase Review

**Review Date:** October 12, 2026  
**Auditor:** Antigravity AI Pair Programmer  
**Repository:** `D:\Planning-Poker` (Branch: `fix/serious-issues`)  
**Architecture:** Static Frontend (GitHub Pages / Vanilla ES Modules) + Serverless Backend (Cloudflare Workers + Durable Objects with SQLite persistence & Hibernation API)

---

## 1. Executive Summary

Sprint Planning Poker has evolved from an initial experimental pub/sub prototype (v1 ntfy.sh) into an enterprise-grade, corporate-firewall-resilient agile estimation tool (v2 Cloudflare Durable Objects). 

### Key Architectural Strengths:
1. **Zero WebRTC Dependency:** Operates exclusively via standard HTTPS (Port 443) and WebSockets (`wss://`), bypassing corporate VPN, Zscaler, Palo Alto, and bank network packet filtering.
2. **Authoritative Single-Source-of-Truth:** Powered by Cloudflare Durable Objects (`PokerRoom`), ensuring zero state divergence, atomic vote reveals, and race-condition immunity.
3. **Cost-Optimized Hibernation:** Employs the Cloudflare Durable Object Hibernation API (`state.acceptWebSocket()`, `state.setWebSocketAutoResponse()`) to sleep idle rooms while holding open WebSocket connections, drastically minimizing duration billing on Cloudflare's free tier.
4. **Resilient Session & Role Recovery:** Robust multi-tab identity separation (`sessionStorage`), automatic reload session restoration, temporary acting-host fallback (when the host drops for >30s), and a privacy-preserving inactive seat reclaim mechanism (`/api/room/claim` via SHA-256 seat refs).
5. **Security Hardening:** Formula injection defense in CSV exports, local offline QR code generation (vendored, zero third-party telemetry), strict HTML entity escaping, and per-socket rate limiting.

---

## 2. Architecture & System Flow

```
                      ┌──────────────────────────────────────────────┐
                      │          Browser Clients (1 - 50+)           │
                      │  - GitHub Pages Static Host (Vanilla JS/CSS) │
                      │  - sessionStorage tab isolation              │
                      │  - Local offline QR generator                │
                      └──────────────────────┬───────────────────────┘
                                             │
                      HTTPS POST & WSS (Port 443)
                                             │
                                             ▼
                      ┌──────────────────────────────────────────────┐
                      │           Cloudflare Worker Router           │
                      │               (src/routes.js)                │
                      │  - Input validation (regex, length)          │
                      │  - CORS & HTTP Method gating                 │
                      │  - Durable Object ID derivation (idFromName) │
                      └──────────────────────┬───────────────────────┘
                                             │
                                             ▼
                      ┌──────────────────────────────────────────────┐
                      │            PokerRoom Durable Object          │
                      │                (src/Room.js)                 │
                      │  - SQLite Storage Persistence                │
                      │  - Hibernation WebSocket API                 │
                      │  - Secret token validation & Host guards     │
                      │  - Inactivity Alarms & Ghost Pruning         │
                      │  - Acting Host delegation                    │
                      └──────────────────────────────────────────────┘
```

---

## 3. Deep-Dive Component Analysis

### A. Backend (`worker/src/`)

#### 1. `Room.js` (Durable Object Core)
- **State Management & Persistence:**
  - Room state (`players`, `tokens`, `votes`, `history`, `lastSeen`, `lastActivity`) is saved to persistent SQLite storage (`this.state.storage.put('room', ...)`).
  - On wake-up, `state.blockConcurrencyWhile` rehydrates persisted state and matches active hibernated sockets using `ws.deserializeAttachment()`.
  - Idle rooms expire cleanly via `state.storage.setAlarm()`, cleaning up after 2 hours (or 12 hours if active sockets remain connected).
- **Hibernation & Ping Handshake:**
  - Native runtime auto-response via `WebSocketRequestResponsePair` intercepts client pings directly at Cloudflare's edge without waking the Durable Object process into memory.
  - Manual WebSocket close reply handshake ensures clean TCP disconnection without browser lingering in `CLOSING` state.
- **Seat Reclamation & Inactive Seats:**
  - If a participant clears browser storage or closes their tab, their seat becomes reclaimable after 20 seconds.
  - Inactive seat references use truncated SHA-256 hashes (`_seatRef`), preventing player ID enumeration.
  - Original host seats are explicitly barred from takeover (`403 Forbidden`).
- **Acting Host Logic:**
  - If the host disconnects for >30s (`HOST_GRACE_MS`), the earliest joined connected player (`joinedAt`) temporarily becomes the acting host. When the original host reconnects, authority seamlessly reverts.

#### 2. `routes.js` & `validation.js`
- **Method Enforcement:** All mutating actions (`vote`, `reveal`, `reset`, `story`, `deck`, `save_story`, `claim`, `create`, `join`) strictly require `POST`, returning `405 Method Not Allowed` for `GET` requests (mitigating CSRF-style image tag abuse).
- **Sanitization:** Single-line string truncation and control-character stripping protect against unprintable ASCII, zero-width spaces, and surrogate exploits without breaking legitimate emoji (`☕`, `❓`).

---

### B. Frontend (`js/` & `index.html`)

#### 1. `network.js` (Resilient Transport Controller)
- **Token Security:** Auth tokens are passed via the first WebSocket message (`{type: 'auth', payload: {token}}`) rather than URL query parameters, preventing credentials from appearing in web server access logs.
- **Sleep & Wake Recovery:** Listens to `document.visibilitychange` and `window.online` to detect laptop lid closing or mobile sleep, pinging the socket with a 3-second zombie check (`ZOMBIE_CHECK_MS`) to trigger immediate reconnection if dead.
- **Optimistic UI with Fallback:** Votes are applied optimistically in local state, with a 4-second reconciliation timeout reverting the card if the server drops or rejects the update.
- **Single-Flight Reconnection:** Prevents concurrent reconnect storms using navigation sequence guards (`_navSeq`).

#### 2. `ui.js` & `css/style.css` (DOM & Interaction Design)
- **Keyed Partial Rendering:** Instead of rebuilding the whole DOM tree on every state broadcast, `ui.js` checks diff keys (`_deckKey`, `_gridKey`, `_statsKey`, `_historyKey`), preserving keyboard focus and active mouse interactions.
- **XSS Immunity:** Player names, story titles, agreed points, and distribution labels are escaped via `escapeHtml()` before template interpolation.
- **Accessibility:** Toast messages are managed via a centralized live region (`#toast-stack` with `role="status"` and `aria-live="polite"`). Modals implement Escape key listeners and focus trapping.
- **3D Card Flip Dynamics:** CSS transforms with `preserve-3d` and `backface-visibility: hidden` produce fluid 60fps card flips when the facilitator triggers reveal.

#### 3. `engine.js` (Calculations & Reporting)
- **Math Engine:** Correctly computes mathematical average, median, consensus flag, and distribution ranges. Gracefully handles 0-averages and non-numeric deck cards (`XS`, `M`, `☕`, `❓`).
- **CSV Formula Injection Guard:** Cells starting with formula characters (`=`, `+`, `-`, `@`, `\t`, `\r`) are automatically escaped with single quotes (`'`), preventing malicious spreadsheet execution in Microsoft Excel and Google Sheets.
- **Safe Export via Blob:** Uses UTF-8 BOM (`\ufeff`) and `URL.createObjectURL(new Blob(...))` to prevent data truncation on `#` or non-ASCII characters.

#### 4. `qrcode.js` & `usage.js`
- **Offline QR Generation:** Replaced external third-party API image calls (`api.qrserver.com`) with a vendored `qrcode-generator.js` library, eliminating corporate firewall blocks and privacy leaks.
- **API Usage Tracker:** Visual SVG ring informs the user of browser request volumes against Cloudflare's 100,000 requests/day free tier.

---

## 4. Findings & Recommendations Matrix

| Severity | Category | Description | Recommended Solution |
| :--- | :--- | :--- | :--- |
| **Medium** | **Security / Quota** | `/api/room/create` has no per-IP rate limiting; bad actors could script room generation to exhaust Cloudflare free tier quotas. | Enable Cloudflare WAF rate limiting rule on `POST /api/room/create` (e.g., max 10 requests / min per IP). |
| **Medium** | **Security** | `CORS_HEADERS` allows wildcard origin (`*`). While safe for public rooms, it allows external sites to trigger room endpoints. | Configure an Origin check against `https://raaghav99.github.io` and `localhost` in production. |
| **Low** | **Config** | `window.WORKER_URL` is hardcoded in `index.html` line 11 (`https://sprint-poker-worker.temp66081.workers.dev`). | Safe for current deployment, but consider abstracting to an environment config or dynamic detection if staging/prod workers differ. |
| **Low** | **UX / Edge Case** | If two people try to claim the exact same inactive seat within milliseconds, the second receives an error toast. | The current UI automatically re-fetches the seat list on `404`/`409`, which is sufficient; adding an explicit prompt "Someone just claimed this seat" clarifies the notice. |
| **Low** | **Quota Visibility** | `usage.js` tracks requests per-browser `localStorage`, not the global account-wide Cloudflare quota. | The tooltip already clarifies this ("Requests sent from this browser today"), but adding a small footnote "Shared account quota" avoids confusion. |

---

## 5. Verification Checklist

- [x] **Zero WebRTC Dependency:** Verified exclusively WebSocket and REST over standard HTTPS/443.
- [x] **XSS Sanitization:** All user-controlled inputs are escaped before injection into DOM.
- [x] **CSV Security:** Formula injection characters neutralized; BOM and Blob URLs properly formatted.
- [x] **Session Persistence:** Reloading re-joins active seat; `sessionStorage` avoids cross-tab collisions.
- [x] **Host Authority:** Facilitator controls (`reveal`, `reset`, `story`, `deck`, `save_story`) strictly validated server-side.
- [x] **Acting Host Failover:** Unattended host drops temporarily delegate controls without losing host ownership.
- [x] **Offline QR Code:** Generates locally in-browser without external network calls.
- [x] **Cloudflare Hibernation API:** Memory-idle WebSockets and runtime auto-responses active.

---

## 6. Conclusion

The codebase is exceptionally well-engineered for its purpose. The transition to Cloudflare Durable Objects with the Hibernation API solves the race conditions, corporate firewall drops, and polling latency of earlier iterations. The repository is clean, reliable, and ready for production deployment.
