# Sprint Planning Poker v2.0
# Cloudflare Workers + Durable Objects Architecture Plan

> **Status:** Active v2.0 Architecture  
> **Frontend:** GitHub Pages (Static)  
> **Backend:** Cloudflare Workers + Durable Objects  
> **Database:** None  
> **Authentication:** None (Players)  
> **Transport:** HTTPS + WebSockets (Port 443)  
> **Storage:** Ephemeral (Memory Only inside Durable Objects)  

---

# Why We Replaced ntfy.sh

The initial implementation used **ntfy.sh** as a public HTTPS Pub/Sub relay.

Although it solved initial connection challenges:
- No authentication
- Corporate firewall friendly
- Static website deployment
- Zero backend maintenance

it introduced architectural limitations that become difficult to solve correctly at scale.

## Problems with ntfy.sh

### 1. ntfy is a Message Broker, Not a Database
The previous implementation assumed room state could be updated atomically.
Since message brokers do not maintain a single shared room document or transaction state, clients had to reconstruct state manually.

### 2. Race Conditions
If the Host presses **Reveal** while a player submits a vote simultaneously, different clients could observe different ordering due to lack of central synchronization.

### 3. Polling Delay
HTTP polling every 1.5 seconds leads to unnecessary network traffic, delayed card flip updates, and implementation complexity.

---

# New v2.0 Architecture Goals

The new architecture provides:

- ✅ Static GitHub Pages frontend
- ✅ Zero database / Zero permanent storage
- ✅ Zero authentication required for players
- ✅ 100% Corporate firewall compatible (HTTPS / WSS over Port 443)
- ✅ Race-condition-free single source-of-truth room state
- ✅ Sub-second WebSocket real-time card flips
- ✅ Automatic in-memory room expiration (2 hours)

---

# High-Level Architecture

```
                    GitHub Pages
                 (Static Frontend)
                         │
                         │ HTTPS / WSS (Port 443)
                         ▼
              Cloudflare Worker Router
                         │
             ┌───────────┴────────────┐
             ▼                        ▼
      Room ABC123              Room XZY987
   Durable Object          Durable Object
```

Each planning room becomes its own isolated Durable Object instance.

---

# Why Durable Objects?

Durable Objects provide **exactly one authoritative instance** for each room code.

Instead of trying to synchronize multiple clients independently:
- All 20+ clients communicate with **one room object**.
- Eliminates race conditions.
- Zero polling necessary.
- State resides purely in memory.

---

# Communication & Event Model

Client → Server (WebSocket / HTTP REST)
- `join`
- `vote`
- `reveal`
- `reset`
- `story`
- `deck`
- `save_story`
- `ping`

Server → Client (WebSocket Broadcast)
- `room_state`
- `room_updated`
- `room_closed`

---

# Corporate Firewall Compatibility

The architecture remains enterprise friendly:
- Traffic uses standard **HTTPS** and **WSS** over **Port 443**.
- Unlike WebRTC: No STUN, no TURN, no UDP hole punching, no peer discovery.
- Fully compatible with corporate VPNs, Zscaler, Palo Alto NextGen Firewalls, and bank networks.
