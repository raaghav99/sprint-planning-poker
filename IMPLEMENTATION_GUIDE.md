# 🃏 Sprint Planning Poker – Technical Implementation & Architecture Guide

This document explains what was built, why specific design choices were made, and how the system is implemented in the codebase.

---

## 🎯 Executive Summary

**Sprint Planning Poker** is a serverless, corporate-firewall-compatible Agile estimation web application for engineering teams. 

Key Requirements Addressed:
1. **Zero WebRTC Dependency**: Many corporate laptops and company VPNs block WebRTC P2P streams and STUN/TURN UDP packets. This app uses standard HTTPS REST polling over Port 443 so it **never gets blocked by enterprise firewalls (Zscaler, Palo Alto, Cisco AnyConnect, etc.)**.
2. **Instant QR Code & URL Link Sharing**: Room URLs encode the room code (`?room=A7B9K2`). Mobile phones can scan the QR code to join sessions instantly.
3. **Supports 20+ Simultaneous Members**: Scalable seating grid and distribution charts.
4. **State Persistence & Reconnection**: Page refreshes or tab closes restore the active session automatically without losing votes.
5. **Clean Repository Isolation**: Built as a standalone repository hosted on [GitHub Pages](https://raaghav99.github.io/sprint-planning-poker/).

---

## 🏗️ Architectural Overview

```
 ┌─────────────────────────────────────────────────────────────┐
 │                      Frontend Layer                         │
 │  (HTML5, Vanilla CSS Glassmorphic UI, ES Modules, 3D Cards) │
 └──────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │                    State & Engine Layer                     │
 │      (pokerState, Local Cache, PokerEngine Statistics)      │
 └──────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │                 Network Synchronization Layer               │
 │            (Zero-WebRTC HTTPS Pub/Sub Relay)                │
 └──────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │                    Global Cloud Store                       │
 │             (https://ntfy.sh/sprint_poker_room_*)           │
 └─────────────────────────────────────────────────────────────┘
```

---

## 📁 Codebase Structure & File Breakdown

### 1. `index.html` — Application Layout & Views
- Built using semantic HTML5 elements.
- Divided into two primary view panels:
  - **Lobby View** (`#view-lobby`): Facilitates hosting or joining rooms with auto-filled Room Codes from URL query parameters (`?room=XYZ`).
  - **Active Room View** (`#view-room`): Contains the Story Header, 20-Player Poker Table Felt, Facilitator Control Bar, Results Drawer, Interactive Voting Deck, and History Log.

### 2. `css/style.css` — Design System & Animations
- **Glassmorphic Aesthetic**: Deep dark backdrop (`#0b0f19`) with HSL radial gradients, subtle glass borders (`rgba(255,255,255,0.08)`), and blur filters.
- **3D Card Flip Animation**: Uses CSS 3D perspective transforms (`perspective: 1000px; transform-style: preserve-3d; transition: transform 0.6s`). Adding the `.flipped` class rotates the card 180° around the Y-axis to reveal estimates.
- **Responsive Layout**: Flexbox and CSS Grid adapt fluidly across mobile phones, tablets, and desktop displays.

### 3. `js/state.js` — Client State Management & Local Cache
- Uses an Event Emitter pub/sub pattern (`pokerState`).
- Manages room state: `role`, `roomCode`, `displayName`, `myPeerId`, `currentStory`, `deckType`, `roundStatus`, `players`, `votes`, `myVote`, and `history`.
- Stores user credentials in `localStorage` so refreshing the browser tab retains player identity.

### 4. `js/network.js` — Zero-WebRTC Cloud Synchronization Engine
- **Global Transport**: Uses `https://ntfy.sh/sprint_poker_room_ROOMCODE` as a high-availability HTTPS pub/sub relay.
- **`createRoom(roomCode, displayName)`**: Initializes host state and posts the initial payload to `ntfy.sh`.
- **`joinRoom(roomCode, displayName)`**: Fetches the room payload over HTTPS, appends the joining player to the roster, and starts the 1.5-second polling loop.
- **`submitVote(estimate)`**: Atomically updates the player's vote in the cloud payload.
- **`revealVotes()` / `resetVotes()`**: Allows the Host to switch round status or clear votes for re-voting.

### 5. `js/engine.js` — Math Engine & CSV Exporter
- **`calculateStats(votes)`**: Calculates Numerical Average, Median, Min/Max range, Vote Distribution breakdown, and Unanimous Consensus badges.
- **`exportToCSV(history)`**: Converts saved sprint story estimates into a downloadable `.csv` file.

### 6. `js/qrcode.js` — QR Code Modal Generator
- Generates 220x220 scannable QR code images via API.
- Renders an interactive glassmorphic modal overlay with **Copy Link** and **Close** buttons.

### 7. `js/ui.js` — DOM Controller & Event Listener
- Connects state updates to DOM rendering.
- Manages deck selections, card clicks, facilitator actions, and notification toasts.

---

## 🛠️ How Features Were Implemented

### 1. Zero-WebRTC Corporate Firewall Bypass
- Standard WebRTC P2P applications fail in enterprise environments because firewalls block UDP ports and STUN/TURN servers.
- **Our Approach**: All data transfer occurs over standard **HTTPS GET/POST requests on Port 443**. Enterprise firewalls treat this as normal web browsing traffic (identical to Slack or GitHub).

### 2. Instant QR Code & Link Joining
- When a room is created, the URL is formatted as `https://raaghav99.github.io/sprint-planning-poker/?room=XYZ`.
- Clicking **📱 QR Code** generates a mobile-optimized QR code. Scanning it pre-fills `room=XYZ`, allowing mobile users to tap **Join Session** instantly.

### 3. Secret Voting & 3D Reveal
- While voting is in progress (`roundStatus: 'VOTING'`), player cards show a green back with a `👍` badge indicating they have voted, keeping the actual estimate secret.
- Clicking **👁️ Reveal Votes** sets `roundStatus: 'REVEALED'`, causing all player card elements to add `.flipped`, revealing numbers simultaneously with 3D CSS physics.

---

## 🚀 Deployment & GitHub Pages Configuration

- **Repository**: `https://github.com/raaghav99/sprint-planning-poker`
- **Branch**: `main`
- **Live URL**: `https://raaghav99.github.io/sprint-planning-poker/`
- **Cache Invalidation**: Script imports in `index.html` include version query strings (`js/app.js?v=1.0.5`) to force browsers to fetch the latest modules immediately.
