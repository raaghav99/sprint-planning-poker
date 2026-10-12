/**
 * Sprint Planning Poker v2.0 - PokerRoom Durable Object
 * Authoritative room state. Persisted to storage so rooms survive eviction.
 *
 * Auth model (phased, backwards compatible):
 *  - create/join issue a secret token to NEW players. Players that hold a token must
 *    present it (REST body `token`, or first WS message `{type:'auth'}`).
 *  - Players without a token (rooms/clients created before this version) stay "legacy"
 *    and keep working unauthenticated until tokens are enforced for everyone.
 *  - Host-only actions are always enforced server-side.
 *
 * WebSockets use the Hibernation API: the object can be evicted from memory while sockets
 * stay open (no duration billing while idle). Everything needed is therefore either in
 * storage (room snapshot) or in each socket's attachment ({ playerId, authed }).
 */

import { sendJSON } from './websocket.js';
import { CORS_HEADERS, ROOM_TIMEOUT_MS, MAX_PLAYERS, DECKS } from './constants.js';
import {
    isValidRoomCode, isValidPlayerId, sanitizeName, sanitizeText, sanitizeLine, randomHex
} from './validation.js';

const ACTIONS = new Set(['vote', 'reveal', 'reset', 'story', 'deck', 'save_story', 'make_host']);
const MAX_MSG_CHARS = 4096;
const MAX_HISTORY = 100;
const CONNECTED_ROOM_TIMEOUT_MS = 6 * ROOM_TIMEOUT_MS; // rooms with live sockets get a longer idle window
const RATE_WINDOW_MS = 10000;
const RATE_MAX_MSGS = 60;
const AUTH_TIMEOUT_MS = 10000;
const MAX_PENDING_AUTH = 20; // unauthenticated sockets held open per room
const MAX_PENDING_PER_PLAYER = 3;
const GHOST_MS = 10 * 60 * 1000; // disconnected non-host players are removed after this long (rejoin window)
const HOST_GRACE_MS = 30 * 1000; // host may be offline this long (reload, flaky wifi) before an acting host takes over
const SEAT_INACTIVE_MS = 10 * 1000; // a seat must be offline this long before the same name can take it over
// Answered by the runtime without waking the object. Must match the client's ping byte for byte.
const PING_REQUEST = '{"type":"ping","payload":{}}';
const PONG_RESPONSE = '{"event":"pong","payload":{},"timestamp":0}';
const DEFAULT_STORY = {
    title: 'User Story #1',
    description: 'Estimate complexity for this task'
};

// A player's name is their identity inside a room: compare case-insensitively, ignoring spacing.
function nameKey(name) {
    return String(name || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export class PokerRoom {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this._rate = new WeakMap(); // ws -> { start, count } message rate window
        this._reset();

        this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_REQUEST, PONG_RESPONSE));

        // Rehydrate persisted room and reattach live sockets before handling any request.
        this.state.blockConcurrencyWhile(async () => {
            const saved = await this.state.storage.get('room');
            if (saved) this._hydrate(saved);

            for (const ws of this.state.getWebSockets()) {
                const att = this._attachment(ws);
                if (!att) continue;
                if (att.authed && this.players.has(att.playerId)) {
                    this.sockets.set(att.playerId, ws);
                    this.lastSeen.set(att.playerId, Date.now());
                } else if (att.authed) {
                    try { ws.close(4003, 'seat no longer exists'); } catch (e) {}
                }
            }
            this._sweepUnauthed();
        });
    }

    /* ---- State lifecycle ---- */

    _reset() {
        this.roomCode = null;
        this.hostId = null;
        this.players = new Map(); // playerId -> { id, displayName, joinedAt }
        this.tokens = new Map(); // playerId -> secret token (never sent to clients)
        this.currentStory = { ...DEFAULT_STORY };
        this.deckType = 'fibonacci';
        this.votes = new Map(); // playerId -> vote string
        this.revealed = false;
        this.history = [];
        this.sockets = new Map(); // playerId -> authenticated WebSocket
        this.lastSeen = new Map(); // playerId -> last time they were connected/joined (memory only)
        this._pendingAuth = 0;
        this._announcedHost = null; // host id last broadcast to clients
        this.hostLeft = false; // the host pressed Exit: hand over at once instead of waiting out the grace period
        this.lastActivity = Date.now();
        this._alarmAt = 0;
    }

    _hydrate(saved) {
        this.roomCode = saved.roomCode || null;
        this.hostId = saved.hostId || null;
        this.players = new Map((saved.players || []).map((p) => [p.id, p]));
        this.tokens = new Map(saved.tokens || []);
        this.currentStory = saved.currentStory || { ...DEFAULT_STORY };
        this.deckType = DECKS[saved.deckType] ? saved.deckType : 'fibonacci';
        this.votes = new Map(saved.votes || []);
        this.revealed = Boolean(saved.revealed);
        this.history = saved.history || [];
        this.lastActivity = saved.lastActivity || Date.now();
        this.hostLeft = Boolean(saved.hostLeft);
        // Restore when each player was last seen: re-stamping everyone with "now" on every wake
        // would keep resetting the ghost clock and ghosts would never be pruned.
        const now = Date.now();
        const savedSeen = new Map(saved.lastSeen || []);
        this.players.forEach((_, id) => this.lastSeen.set(id, savedSeen.get(id) ?? now));
    }

    _snapshot() {
        return {
            roomCode: this.roomCode,
            hostId: this.hostId,
            players: Array.from(this.players.values()),
            tokens: Array.from(this.tokens.entries()),
            currentStory: this.currentStory,
            deckType: this.deckType,
            votes: Array.from(this.votes.entries()),
            revealed: this.revealed,
            history: this.history,
            lastSeen: Array.from(this.lastSeen.entries()),
            hostLeft: this.hostLeft,
            lastActivity: this.lastActivity
        };
    }

    // Fire-and-forget: the Durable Object output gate holds responses until the write lands.
    _persist() {
        this.state.storage.put('room', this._snapshot()).catch((err) => {
            console.warn('[Persist Error]:', err);
        });
        this._scheduleAlarm();
    }

    _ghostMs() {
        return Number(this.env && this.env.GHOST_MS) || GHOST_MS;
    }

    _hostGraceMs() {
        return Number(this.env && this.env.HOST_GRACE_MS) || HOST_GRACE_MS;
    }

    _seatInactiveMs() {
        return Number(this.env && this.env.SEAT_INACTIVE_MS) || SEAT_INACTIVE_MS;
    }

    // The original host keeps the seat. If they have been offline longer than the grace period,
    // the earliest-joined connected player acts as host until the original host returns.
    _effectiveHostId() {
        const host = this.hostId;
        if (!host) return null;
        if (this.sockets.has(host)) return host;
        const awayMs = Date.now() - (this.lastSeen.get(host) ?? Date.now());
        // An accidental drop (reload, flaky wifi) gets a grace period; an explicit Exit hands over at once.
        if (!this.hostLeft && awayMs < this._hostGraceMs()) return host;
        let acting = null;
        for (const p of this.players.values()) {
            if (p.id === host || !this.sockets.has(p.id)) continue;
            if (!acting || p.joinedAt < acting.joinedAt) acting = p;
        }
        return acting ? acting.id : host;
    }

    // Earliest moment something needs attention: a ghost player to prune, or room expiry.
    _nextAlarmAt() {
        const now = Date.now();
        const limit = this.sockets.size > 0 ? CONNECTED_ROOM_TIMEOUT_MS : ROOM_TIMEOUT_MS;
        let at = this.lastActivity + limit;
        // Only deadlines still in the future: a past one has already been handled (or cannot fire
        // again) and would otherwise re-arm the alarm every second forever.
        if (this.hostId && !this.sockets.has(this.hostId)) {
            const hostDue = (this.lastSeen.get(this.hostId) ?? now) + this._hostGraceMs() + 1000;
            if (hostDue > now) at = Math.min(at, hostDue);
        }
        const ghostMs = this._ghostMs();
        for (const id of this.players.keys()) {
            if (id === this.hostId || this.sockets.has(id)) continue;
            const ghostDue = (this.lastSeen.get(id) ?? now) + ghostMs + 1000;
            if (ghostDue > now) at = Math.min(at, ghostDue);
        }
        return Math.max(at, now + 1000);
    }

    _scheduleAlarm() {
        if (!this.roomCode) return;
        const now = Date.now();
        const at = this._nextAlarmAt();
        // An earlier alarm is already pending: it will call back here and reschedule.
        if (this._alarmAt > now && this._alarmAt <= at) return;
        this._alarmAt = at;
        this.state.storage.setAlarm(at).catch((err) => {
            console.warn('[Alarm Error]:', err);
        });
    }

    // Prunes ghost players and expires rooms with no real activity (pings do not count).
    async alarm() {
        this._alarmAt = 0;
        if (!this.roomCode) return;

        this._sweepUnauthed();
        this._pruneGhosts();
        if (this._effectiveHostId() !== this._announcedHost) this.broadcastState(); // acting host changed

        const limit = this.sockets.size > 0 ? CONNECTED_ROOM_TIMEOUT_MS : ROOM_TIMEOUT_MS;
        if (Date.now() - this.lastActivity >= limit) {
            for (const socket of this.state.getWebSockets()) {
                try { socket.close(4002, 'room expired'); } catch (e) {}
            }
            await this.state.storage.deleteAll();
            this._reset();
            return;
        }
        this._scheduleAlarm();
    }

    /* ---- Helpers ---- */

    // Close unauthenticated sockets that outlived the auth window (their setTimeout dies when the
    // object hibernates) and recompute the pending counters from the live sockets.
    // Returns how many unauthenticated sockets are still pending for `playerId`.
    _sweepUnauthed(playerId = null) {
        const now = Date.now();
        let total = 0;
        let forPlayer = 0;
        for (const ws of this.state.getWebSockets()) {
            const att = this._attachment(ws);
            if (!att || att.authed) continue;
            if (now - (att.t || 0) > AUTH_TIMEOUT_MS) {
                try { ws.close(4001, 'auth timeout'); } catch (e) {}
                continue;
            }
            total++;
            if (att.playerId === playerId) forPlayer++;
        }
        this._pendingAuth = total;
        return forPlayer;
    }

    // Remove players that disconnected a while ago (never the host, so they can come back).
    _pruneGhosts() {
        const ghostMs = this._ghostMs();
        const now = Date.now();
        let changed = false;
        for (const id of Array.from(this.players.keys())) {
            if (id === this.hostId || this.sockets.has(id)) continue;
            if (now - (this.lastSeen.get(id) ?? now) < ghostMs) continue;
            // The token stays reserved: only the rightful owner can reclaim this id.
            this.players.delete(id);
            this.votes.delete(id);
            this.lastSeen.delete(id);
            changed = true;
        }
        // Bound the reserved-token list: drop the oldest tokens of players that are gone.
        if (this.tokens.size > MAX_PLAYERS * 4) {
            for (const id of this.tokens.keys()) {
                if (this.tokens.size <= MAX_PLAYERS * 2) break;
                if (!this.players.has(id)) this.tokens.delete(id);
            }
        }
        if (changed) {
            this._persist();
            this.broadcastState();
        }
    }

    json(obj, status = 200) {
        return new Response(JSON.stringify(obj), {
            status,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
    }

    async readBody(request) {
        try {
            const body = await request.json();
            return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
        } catch (e) {
            return null;
        }
    }

    checkToken(playerId, token) {
        const expected = this.tokens.get(playerId);
        if (!expected) return true; // legacy player (no token issued)
        if (typeof token !== 'string' || token.length !== expected.length) return false;
        let diff = 0;
        for (let i = 0; i < expected.length; i++) {
            diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
        }
        return diff === 0;
    }

    /* ---- Request routing ---- */

    async fetch(request) {
        try {
            return await this._fetch(request);
        } catch (err) {
            console.error('[Room Error]:', err);
            return this.json({ error: 'Internal error' }, 500);
        }
    }

    async _fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        if (request.headers.get('Upgrade') === 'websocket') {
            return this.handleWebSocket(request);
        }

        const action = path.split('/').pop();

        if (action === 'create' && request.method === 'POST') return this.handleCreate(request);
        if (action === 'join' && request.method === 'POST') return this.handleJoin(request);
        if (action === 'state' && request.method === 'GET') return this.handleGetState();
        if (action === 'seats' && request.method === 'GET') return this.handleSeats();
        if (action === 'claim' && request.method === 'POST') return this.handleClaim(request);
        if (action === 'leave' && request.method === 'POST') return this.handleLeave(request);
        if (ACTIONS.has(action) && request.method === 'POST') return this.handleAction(request, action);

        return this.json({ error: 'Endpoint not found' }, 404);
    }

    /* ---- REST Handlers ---- */

    async handleCreate(request) {
        const body = await this.readBody(request);
        if (!body) return this.json({ error: 'Invalid JSON body' }, 400);

        if (this.roomCode) return this.json({ error: 'Room already exists' }, 409);

        const code = typeof body.roomCode === 'string' ? body.roomCode.trim().toUpperCase() : '';
        if (!isValidRoomCode(code)) return this.json({ error: 'Invalid room code' }, 400);
        if (!isValidPlayerId(body.playerId)) return this.json({ error: 'Invalid player id' }, 400);

        this._reset();
        this.roomCode = code;
        this.hostId = body.playerId;
        this.players.set(body.playerId, {
            id: body.playerId,
            displayName: sanitizeName(body.displayName, 'Host'),
            joinedAt: Date.now()
        });
        // Only clients that opt in (authVersion 1) get a token; older cached clients stay legacy.
        let token;
        if (body.authVersion === 1) {
            token = randomHex(24);
            this.tokens.set(body.playerId, token);
        }
        this.lastSeen.set(body.playerId, Date.now());
        this._persist();

        return this.json({
            success: true,
            roomCode: this.roomCode,
            ...(token ? { token } : {}),
            state: this.getSanitizedState(body.playerId)
        });
    }

    async handleJoin(request) {
        if (!this.roomCode) return this.json({ error: 'Room does not exist' }, 404);

        const body = await this.readBody(request);
        if (!body) return this.json({ error: 'Invalid JSON body' }, 400);
        if (!isValidPlayerId(body.playerId)) return this.json({ error: 'Invalid player id' }, 400);

        this._pruneGhosts();

        const playerId = body.playerId;
        const providedName = sanitizeLine(body.displayName, 30);
        const existing = this.players.get(playerId);
        let token;

        if (existing) {
            // Returning player: must prove ownership when a token was issued.
            if (!this.checkToken(playerId, body.token)) {
                return this.json({ error: 'Player id is already in use' }, 403);
            }
            if (providedName && nameKey(providedName) !== nameKey(existing.displayName)) {
                if (this._nameClash(providedName, playerId)) {
                    return this.json({
                        error: 'That name is already in use in this room. Pick a different name.',
                        code: 'name_in_use'
                    }, 409);
                }
            }
            if (providedName) existing.displayName = providedName;
        } else {
            // A pruned player's id stays reserved for its token holder.
            if (this.tokens.has(playerId) && !this.checkToken(playerId, body.token)) {
                return this.json({ error: 'Player id is already in use' }, 403);
            }
            // The name is the identity: same name as someone else is refused, or offered as "join back".
            // A returning owner (reserved, token-verified id) is never turned away: if their name was
            // taken meanwhile they get their seat back under a unique variant of it.
            const returning = this.tokens.has(playerId);
            const clash = providedName ? this._nameClash(providedName, playerId) : null;
            if (clash && !returning) return this._clashResponse(clash);
            if (this.players.size >= MAX_PLAYERS) {
                return this.json({ error: 'Room is full' }, 400);
            }
            const displayName = clash ? this._uniqueName(providedName) : (providedName || this._uniqueName('Guest'));
            this.players.set(playerId, { id: playerId, displayName, joinedAt: Date.now() });
            if (this.tokens.has(playerId)) {
                token = this.tokens.get(playerId); // returning owner keeps the same token
            } else if (body.authVersion === 1) {
                token = randomHex(24);
                this.tokens.set(playerId, token);
            }
        }

        this.lastActivity = Date.now();
        this.lastSeen.set(playerId, Date.now());
        if (playerId === this.hostId) this.hostLeft = false; // the host is back
        this._persist();
        this.broadcastState();

        return this.json({
            success: true,
            roomCode: this.roomCode,
            ...(token ? { token } : {}),
            state: this.getSanitizedState(playerId)
        });
    }

    // Another player in the room with the same (normalized) name, or null.
    _nameClash(name, exceptId) {
        const key = nameKey(name);
        for (const p of this.players.values()) {
            if (p.id !== exceptId && nameKey(p.displayName) === key) return p;
        }
        return null;
    }

    // "Guest", "Guest 2", ... when nobody supplied a name.
    _uniqueName(base) {
        let name = base;
        for (let i = 2; this._nameClash(name, null); i++) name = `${base} ${i}`;
        return name;
    }

    // The name belongs to an inactive seat -> offer "join back"; to someone online -> refuse.
    async _clashResponse(clash) {
        if (this._isInactive(clash.id)) {
            return this.json({
                error: `${clash.displayName} is inactive. Join back as ${clash.displayName}?`,
                code: 'name_inactive',
                seatRef: await this._seatRef(clash.id),
                seatName: clash.displayName
            }, 409);
        }
        return this.json({
            error: 'That name is already in use in this room. Pick a different name.',
            code: 'name_in_use'
        }, 409);
    }

    // Opaque, stable reference for a seat so the public list never exposes real player ids.
    async _seatRef(playerId) {
        const data = new TextEncoder().encode(`${this.roomCode}|${playerId}|seat`);
        const digest = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
    }

    _isInactive(playerId) {
        if (this.sockets.has(playerId)) return false;
        return Date.now() - (this.lastSeen.get(playerId) ?? Date.now()) >= this._seatInactiveMs();
    }

    // Public list of seats that can be taken over: offline for a while (the host seat included).
    async handleSeats() {
        if (!this.roomCode) return this.json({ error: 'Room does not exist' }, 404);
        const now = Date.now();
        const seats = [];
        for (const p of this.players.values()) {
            if (!this._isInactive(p.id)) continue;
            seats.push({
                ref: await this._seatRef(p.id),
                displayName: p.displayName,
                inactiveSeconds: Math.round((now - (this.lastSeen.get(p.id) ?? now)) / 1000)
            });
        }
        seats.sort((a, b) => a.inactiveSeconds - b.inactiveSeconds);
        return this.json({ seats });
    }

    // Take over an inactive seat (e.g. after losing the token): the seat's name, join order and
    // vote move to the caller's id, and the old id/token stop working.
    async handleClaim(request) {
        if (!this.roomCode) return this.json({ error: 'Room does not exist' }, 404);
        const body = await this.readBody(request);
        if (!body) return this.json({ error: 'Invalid JSON body' }, 400);
        if (!isValidPlayerId(body.playerId)) return this.json({ error: 'Invalid player id' }, 400);
        if (typeof body.seatRef !== 'string' || !/^[0-9a-f]{16}$/.test(body.seatRef)) {
            return this.json({ error: 'Invalid seat' }, 400);
        }
        if (body.authVersion !== 1) return this.json({ error: 'Update the page and try again' }, 400);

        const newId = body.playerId;
        if (this.players.has(newId)) {
            return this.json({ error: 'You already have a seat in this room', code: 'own_seat' }, 409);
        }
        if (this.tokens.has(newId)) {
            // Reserved by a pruned seat: only its rightful owner may reuse the id (and drops the old token)
            if (!this.checkToken(newId, body.token)) {
                return this.json({ error: 'Player id is already in use', code: 'own_seat' }, 403);
            }
            // The reservation is replaced by the new token only after every check below passes.
        }

        let seat = null;
        for (const p of this.players.values()) {
            if (await this._seatRef(p.id) === body.seatRef) { seat = p; break; }
        }
        if (!seat) return this.json({ error: 'Seat not found. It may have been taken or removed.' }, 404);
        if (this.players.has(newId)) {
            return this.json({ error: 'You already have a seat in this room', code: 'own_seat' }, 409);
        }
        if (!this._isInactive(seat.id)) return this.json({ error: 'That seat is active right now' }, 409);

        // Transfer the seat. joinedAt is reset so a claim can never inherit an older join order
        // (that order decides who acts as host while the host is away).
        const wasHost = seat.id === this.hostId;
        this.players.delete(seat.id);
        this.players.set(newId, { id: newId, displayName: seat.displayName, joinedAt: Date.now() });
        if (wasHost) {
            this.hostId = newId; // the real host came back on another device
            this.hostLeft = false;
        }
        for (const ws of this.state.getWebSockets()) {
            const att = this._attachment(ws);
            if (att && att.playerId === seat.id) {
                try { ws.close(4003, 'seat was taken over'); } catch (e) {}
            }
        }
        if (this.votes.has(seat.id)) {
            this.votes.set(newId, this.votes.get(seat.id));
            this.votes.delete(seat.id);
        }
        this.tokens.delete(seat.id);
        this.lastSeen.delete(seat.id);
        const token = randomHex(24);
        this.tokens.set(newId, token);
        this.lastSeen.set(newId, Date.now());
        this.lastActivity = Date.now();

        this._persist();
        this.broadcastState();

        return this.json({
            success: true,
            roomCode: this.roomCode,
            token,
            state: this.getSanitizedState(newId)
        });
    }

    // Explicit "Exit": the seat disappears at once, so no ghost is left behind. The host keeps the
    // seat (and only drops the connection) so they can return or hand the role over.
    async handleLeave(request) {
        if (!this.roomCode) return this.json({ success: true });
        const body = await this.readBody(request);
        if (!body) return this.json({ error: 'Invalid JSON body' }, 400);

        const playerId = body.playerId;
        if (!isValidPlayerId(playerId) || !this.players.has(playerId)) {
            return this.json({ success: true });
        }
        if (!this.checkToken(playerId, body.token)) {
            return this.json({ error: 'Invalid player token' }, 403);
        }

        const closeSockets = () => {
            for (const ws of this.state.getWebSockets()) {
                const att = this._attachment(ws);
                if (att && att.playerId === playerId) {
                    try { ws.close(1000, 'left'); } catch (e) {}
                }
            }
        };

        if (playerId === this.hostId) {
            closeSockets();
            this.sockets.delete(playerId);
            this.lastSeen.set(playerId, Date.now());
            this.hostLeft = true; // the next person acts as host right away; the host gets it back on return
            this._persist();
            this.broadcastState();
            return this.json({ success: true, kept: true });
        }

        this.players.delete(playerId);
        this.votes.delete(playerId);
        this.tokens.delete(playerId);
        this.lastSeen.delete(playerId);
        this.sockets.delete(playerId);
        closeSockets();

        this.lastActivity = Date.now();
        this._persist();
        this.broadcastState();
        return this.json({ success: true });
    }

    async handleAction(request, action) {
        if (!this.roomCode) return this.json({ error: 'Room does not exist' }, 404);

        const body = await this.readBody(request);
        if (!body) return this.json({ error: 'Invalid JSON body' }, 400);

        const playerId = body.playerId;
        if (!isValidPlayerId(playerId) || !this.players.has(playerId)) {
            return this.json({ error: 'Player not in this room' }, 403);
        }
        if (!this.checkToken(playerId, body.token)) {
            return this.json({ error: 'Invalid player token' }, 403);
        }

        const result = this.applyAction(playerId, action, body);
        if (result.error) return this.json({ error: result.error }, result.status || 400);
        return this.json({ success: true });
    }

    async handleGetState() {
        if (!this.roomCode) return this.json({ error: 'Room does not exist' }, 404);
        // Anonymous view: public summary only (no player ids, host id, votes or history).
        return this.json({
            roomCode: this.roomCode,
            deckType: this.deckType,
            roundStatus: this.revealed ? 'REVEALED' : 'VOTING',
            currentStory: this.currentStory,
            playerCount: this.players.size,
            connectedCount: this.sockets.size
        });
    }

    /* ---- Shared game logic (REST + WebSocket) ---- */

    applyAction(playerId, type, payload) {
        if (!this.players.has(playerId)) {
            return { error: 'Player not in this room', status: 403 };
        }
        if (type !== 'vote' && playerId !== this._effectiveHostId()) {
            return { error: 'Only the host can do that', status: 403 };
        }

        switch (type) {
            case 'vote': {
                if (this.revealed) return { error: 'Votes are locked after reveal', status: 409 };
                const vote = payload.vote;
                if (vote === null || vote === undefined) {
                    this.votes.delete(playerId);
                } else {
                    const card = String(vote);
                    if (!DECKS[this.deckType].includes(card)) {
                        return { error: 'Invalid card for this deck', status: 400 };
                    }
                    this.votes.set(playerId, card);
                }
                break;
            }

            case 'reveal':
                this.revealed = true;
                break;

            case 'reset':
                this.revealed = false;
                this.votes.clear();
                break;

            case 'story': {
                const title = sanitizeLine(payload.title, 120);
                if (!title) return { error: 'Story title is required', status: 400 };
                this.currentStory = { title, description: sanitizeText(payload.description, 500) };
                break;
            }

            case 'deck': {
                const deckType = payload.deckType;
                if (typeof deckType !== 'string' || !Object.prototype.hasOwnProperty.call(DECKS, deckType)) {
                    return { error: 'Unknown deck', status: 400 };
                }
                if (deckType !== this.deckType) {
                    this.deckType = deckType;
                    this.votes.clear(); // old cards are meaningless in the new deck
                    this.revealed = false; // a cleared round must be votable again
                }
                break;
            }

            case 'make_host': {
                // Hand the host role to another connected player (only the current host gets here).
                const target = payload.targetId;
                if (!isValidPlayerId(target) || !this.players.has(target)) {
                    return { error: 'Player not found', status: 404 };
                }
                if (target === playerId) return { error: 'You are already the host', status: 400 };
                if (!this.sockets.has(target)) return { error: 'That player is offline', status: 409 };
                this.hostId = target; // permanent: the previous host becomes a regular player
                this.hostLeft = false;
                break;
            }

            case 'save_story': {
                if (!this.revealed) return { error: 'Reveal votes before saving', status: 409 };
                const agreedPoints = sanitizeLine(
                    typeof payload.agreedPoints === 'number' ? String(payload.agreedPoints) : payload.agreedPoints,
                    20
                );
                if (!agreedPoints) return { error: 'Agreed points are required', status: 400 };
                this.history.push({
                    title: this.currentStory.title,
                    description: this.currentStory.description,
                    agreedPoints,
                    stats: this._calculateStats(),
                    timestamp: Date.now()
                });
                if (this.history.length > MAX_HISTORY) this.history.shift();
                this.revealed = false;
                this.votes.clear();
                break;
            }

            default:
                return { error: 'Unknown action', status: 400 };
        }

        this.lastActivity = Date.now();
        this._persist();
        this.broadcastState();
        return { ok: true };
    }

    /* ---- WebSocket Lifecycle (Hibernation API) ---- */

    _attachment(ws) {
        try {
            return ws.deserializeAttachment();
        } catch (e) {
            return null;
        }
    }

    handleWebSocket(request) {
        if (!this.roomCode) return new Response('Room does not exist', { status: 404 });

        const url = new URL(request.url);
        const playerId = url.searchParams.get('playerId');
        if (!isValidPlayerId(playerId) || !this.players.has(playerId)) {
            return new Response('Unknown player', { status: 403 });
        }

        const needsAuth = this.tokens.has(playerId);
        if (needsAuth) {
            const pendingForPlayer = this._sweepUnauthed(playerId);
            if (this._pendingAuth >= MAX_PENDING_AUTH || pendingForPlayer >= MAX_PENDING_PER_PLAYER) {
                return new Response('Too many pending connections', { status: 429 });
            }
        }

        const pair = new WebSocketPair();
        const [clientWS, serverWS] = Object.values(pair);
        // Hibernatable: the object may be evicted from memory while the socket stays open.
        this.state.acceptWebSocket(serverWS);

        if (needsAuth) {
            // Must send {type:'auth', payload:{token}} first.
            serverWS.serializeAttachment({ playerId, authed: false, t: Date.now() });
            this._pendingAuth++;
            setTimeout(() => {
                const att = this._attachment(serverWS);
                if (att && !att.authed) {
                    try { serverWS.close(4001, 'auth timeout'); } catch (e) {}
                }
            }, AUTH_TIMEOUT_MS);
        } else {
            this._activate(serverWS, playerId, false); // legacy player
        }

        return new Response(null, { status: 101, webSocket: clientWS });
    }

    _activate(ws, playerId, wasPending) {
        ws.serializeAttachment({ playerId, authed: true });
        if (playerId === this.hostId) this.hostLeft = false; // the host is back
        if (wasPending) this._pendingAuth = Math.max(0, this._pendingAuth - 1);
        this.lastActivity = Date.now();
        this.lastSeen.set(playerId, Date.now());

        const previous = this.sockets.get(playerId);
        this.sockets.set(playerId, ws);
        if (previous && previous !== ws && this.tokens.has(playerId)) {
            try { previous.close(4000, 'replaced by newer connection'); } catch (e) {}
        }

        sendJSON(ws, 'room_state', this.getSanitizedState(playerId));
        this.broadcastState();
        this._persist();
    }

    webSocketMessage(ws, message) {
        try {
            const att = this._attachment(ws);
            if (!att) return;
            if (!this.roomCode) {
                ws.close(4002, 'room expired');
                return;
            }
            const playerId = att.playerId;

            if (typeof message !== 'string' || message.length > MAX_MSG_CHARS) return;

            const now = Date.now();
            let rate = this._rate.get(ws);
            if (!rate || now - rate.start > RATE_WINDOW_MS) {
                rate = { start: now, count: 0 };
                this._rate.set(ws, rate);
            }
            if (++rate.count > RATE_MAX_MSGS) return;

            const data = JSON.parse(message);
            if (!data || typeof data !== 'object') return;
            const { type } = data;
            const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};

            if (!att.authed) {
                if (type !== 'auth') return;
                if (!this.players.has(playerId)) {
                    ws.close(4003, 'seat no longer exists');
                    return;
                }
                if (this.checkToken(playerId, payload.token)) {
                    this._activate(ws, playerId, true);
                } else {
                    ws.close(4003, 'invalid token');
                }
                return;
            }

            if (type === 'ping') {
                sendJSON(ws, 'pong'); // normally answered by the runtime auto-response
            } else if (ACTIONS.has(type)) {
                const result = this.applyAction(playerId, type, payload);
                if (result.error) sendJSON(ws, 'error', { message: result.error, action: type });
            }
        } catch (err) {
            console.warn('[WS Message Error]:', err);
        }
    }

    webSocketClose(ws, code) {
        // Complete the close handshake ourselves (older compatibility dates do not auto-reply),
        // otherwise the client sits in CLOSING for several seconds. 1005/1006/1015 cannot be sent.
        const reply = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
        try { ws.close(reply, 'closing'); } catch (e) {}
        this._socketGone(ws);
    }

    webSocketError(ws) {
        try { ws.close(1011, 'error'); } catch (e) {}
        this._socketGone(ws);
    }

    // Only drop the socket if it is still the registered one (a reconnect may have replaced it).
    _socketGone(ws) {
        const att = this._attachment(ws);
        if (!att) return;
        if (!att.authed) {
            this._pendingAuth = Math.max(0, this._pendingAuth - 1);
            return;
        }
        if (!this.players.has(att.playerId)) {
            // the seat was removed (leave/claim): just make sure no stale entry stays behind
            if (this.sockets.get(att.playerId) === ws) this.sockets.delete(att.playerId);
            return;
        }
        const current = this.sockets.get(att.playerId);
        if (current === ws || current === undefined) {
            this.sockets.delete(att.playerId);
            this.lastSeen.set(att.playerId, Date.now());
            this.broadcastState();
            this._persist(); // saves lastSeen so a hibernation/eviction cannot reset the ghost clock
        }
    }

    broadcastState() {
        this._announcedHost = this._effectiveHostId();
        this.sockets.forEach((socket, pId) => {
            sendJSON(socket, 'room_updated', this.getSanitizedState(pId));
        });
    }

    getSanitizedState(forPlayerId) {
        const votesObj = {};
        this.votes.forEach((val, pId) => {
            if (this.revealed || (forPlayerId && pId === forPlayerId)) {
                votesObj[pId] = val; // actual estimate once revealed, or your own vote
            } else {
                votesObj[pId] = '✓'; // secret vote indicator
            }
        });

        const hostId = this._effectiveHostId();
        return {
            roomCode: this.roomCode,
            hostId,
            homeHostId: this.hostId, // the permanent host (differs from hostId only while someone is acting)
            actingHost: Boolean(this.hostId) && hostId !== this.hostId,
            currentStory: this.currentStory,
            deckType: this.deckType,
            roundStatus: this.revealed ? 'REVEALED' : 'VOTING',
            players: Array.from(this.players.values()).map((p) => ({
                id: p.id,
                displayName: p.displayName,
                role: p.id === hostId ? 'HOST' : 'VOTER',
                joinedAt: p.joinedAt,
                connected: this.sockets.has(p.id)
            })),
            votes: votesObj,
            history: this.history,
            totalConnectedSockets: this.sockets.size
        };
    }

    _calculateStats() {
        const vals = Array.from(this.votes.values())
            .map((v) => parseFloat(v))
            .filter((n) => !isNaN(n));
        if (vals.length === 0) return { average: 0, median: 0, totalVotes: this.votes.size };
        vals.sort((a, b) => a - b);
        const sum = vals.reduce((acc, c) => acc + c, 0);
        const avg = Math.round((sum / vals.length) * 10) / 10;
        const mid = Math.floor(vals.length / 2);
        const med = vals.length % 2 === 0 ? Math.round(((vals[mid - 1] + vals[mid]) / 2) * 10) / 10 : vals[mid];
        return { average: avg, median: med, totalVotes: this.votes.size };
    }
}
