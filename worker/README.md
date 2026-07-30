# ⚡ Sprint Planning Poker v2.0 - Cloudflare Worker Backend

In-memory room management powered by **Cloudflare Workers + Durable Objects**.

---

## 🛠️ Deployment to Cloudflare (100% Free Tier)

### 1. Install Wrangler CLI
```bash
npm install -g wrangler
```

### 2. Login to Cloudflare Account
```bash
wrangler login
```

### 3. Deploy Worker
Inside the `worker/` directory, run:
```bash
wrangler deploy
```

Once deployed, Cloudflare will provide your Worker URL:
`https://sprint-poker-worker.<your-subdomain>.workers.dev`

---

## 🔌 API Summary

- **WebSocket Connection**: `wss://<worker-url>/ws?room=A7B9K2&playerId=pid&displayName=Alex`
- **POST `/api/room/create`**: Create a new Durable Object room.
- **POST `/api/room/join`**: Join an existing room.
- **GET `/api/room/state?room=A7B9K2`**: Retrieve public room state snapshot.
