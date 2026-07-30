# 🃏 Sprint Planning Poker – Serverless Agile Estimation Tool

A fast, modern, and beautiful **Sprint Planning Poker** application designed for remote engineering teams.

> **💡 Key Advantage:** Built with zero WebRTC dependencies. It uses standard HTTPS state syncing, which means it **never gets blocked by corporate firewalls, corporate VPNs, Zscaler, or enterprise IT security policies**.

---

## ⚡ Features

- 🔗 **Instant Link Sharing**: Host creates a room code (e.g. `A7B9K2`), and team members join automatically via link (`https://your-domain.com/?room=A7B9K2`).
- 🏢 **Corporate Laptop & VPN Ready**: Works 100% reliably on office Wi-Fi, bank networks, and VPNs (no WebRTC UDP blocking issues).
- 👥 **Supports 20+ Simultaneous Members**: Built for complete sprint planning sessions.
- 🃏 **3D Flip Card Reveal**: Secret vote indicators (`👍`) during voting, with simultaneous 3D flip card animations when revealed.
- 📊 **Automated Analytics & Consensus**: Calculates **Average**, **Median**, **Consensus Status** (Unanimous / Disagreement), and **Vote Distribution Breakdown**.
- 🎴 **Multiple Estimation Decks**: Standard Fibonacci (`0, 1, 2, 3, 5, 8, 13, 21...`), Modified Fibonacci, T-Shirt Sizes (`XS, S, M, L, XL`), and Powers of 2.
- 🔄 **Reconnection & State Persistence**: If a browser tab closes or page refreshes, room state and votes restore automatically.
- 📥 **Export CSV Summary**: Download a spreadsheet report of all estimated user stories at the end of the sprint planning session.

---

## 🚀 Quick Deployment Guide

### Deploying to GitHub Pages (100% Free)

1. Create a new public repository on GitHub named `sprint-planning-poker`.
2. Open terminal in this folder and run:
   ```bash
   git init
   git add .
   git commit -m "Initial commit for Sprint Planning Poker"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/sprint-planning-poker.git
   git push -u origin main
   ```
3. In your GitHub repository settings, go to **Pages** -> Select `main` branch -> Click **Save**.
4. Your site will be live at `https://YOUR_USERNAME.github.io/sprint-planning-poker/`!

### Deploying to Vercel (100% Free)

1. Push code to GitHub.
2. Go to [Vercel.com](https://vercel.com) and click **Add New Project**.
3. Import `sprint-planning-poker` and click **Deploy**.

---

## 🛠️ Project Structure

```
sprint-planning-poker/
├── index.html       # Application HTML layout & views
├── css/
│   └── style.css    # Agile Glassmorphic Dark theme & 3D card flip styles
├── js/
│   ├── app.js       # App entry point
│   ├── ui.js        # DOM rendering & event controller
│   ├── network.js   # Zero-WebRTC Cloud REST Sync Engine (HTTPS fetch)
│   ├── state.js     # Session state & deck definitions
│   └── engine.js    # Statistics calculation & CSV exporter
└── README.md        # Documentation & deployment guide
```
