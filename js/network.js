/**
 * Standalone Sprint Planning Poker v2.0 - Network Controller
 * Supports Cloudflare Workers + Durable Objects WebSocket Architecture (Port 443)
 * Zero WebRTC, Zero Race Conditions, 100% Corporate Firewall Compatible
 */

import {
    pokerState, saveSession, clearSession, rememberSeat, getSeat, forgetSeat,
    setLastRoom, touchLastRoom, clearLastRoom
} from './state.js?v=2.3.1';
import { incrementUsage } from './usage.js?v=2.3.1';

// Default worker URL or relative route if hosted on worker
const DEFAULT_WORKER_URL = window.WORKER_URL || 'https://sprint-poker-worker.temp66081.workers.dev';

// Actions the worker also accepts over REST when the WebSocket is down
const REST_ACTIONS = new Set(['vote', 'reveal', 'reset', 'story', 'deck', 'save_story', 'make_host']);

const REQUEST_TIMEOUT_MS = 10000;
const ZOMBIE_CHECK_MS = 3000; // after wake-up, how long to wait for any reply before recycling the socket

// Close codes sent by the worker: do not auto-reconnect on these
const CLOSE_REPLACED = 4000; // same player connected from another tab
const CLOSE_AUTH_FAILED = 4003;
const CLOSE_EXPIRED = 4002;

class ApiError extends Error {
    constructor(message, status, code, data) {
        super(message);
        this.status = status;
        this.code = code;
        this.data = data || {};
    }
}

export class PokerNetworkController {
    constructor() {
        this.socket = null;
        this.roomCode = null;
        this.isHost = false;
        this.pingInterval = null;
        this._token = null;
        this._navSeq = 0; // bumped by every create/join so a slow older call can't override a newer one
        this._pendingVote = null;
        /** Optional callback(message) for server-side/connection problems */
        this.onError = null;
        /** Optional callback(message) for informational events (e.g. acting host changes) */
        this.onNotice = null;

        // Phones/laptops drop sockets while asleep: reconnect as soon as the page is usable again.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this.resync();
        });
        window.addEventListener('online', () => {
            if (document.visibilityState === 'visible') this.resync();
        });
    }

    /** Reconnect now if the socket is down (resets the backoff). */
    resync() {
        if (!this._roomCode) return;
        const ready = this.socket ? this.socket.readyState : -1;
        if (ready === WebSocket.OPEN) {
            // A socket can look open after sleep but be dead. Ping it; no reply -> recycle it.
            const ws = this.socket;
            const sentAt = Date.now();
            try { ws.send(JSON.stringify({ type: 'ping', payload: {} })); } catch (e) {}
            setTimeout(() => {
                if (this.socket === ws && (this._lastMessageAt || 0) < sentAt) ws.close();
            }, ZOMBIE_CHECK_MS);
            return;
        }
        if (ready === WebSocket.CONNECTING) return;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        this._reconnectAttempts = 0;
        this._reconnect();
    }

    /**
     * Re-register our seat (idempotent join) before reopening the socket, so a seat that was
     * pruned while we were offline is restored, and a deleted room is reported cleanly.
     */
    async _reconnect() {
        // Single-flight: resync(), backoff timers and close handlers can all ask for this.
        if (!this._roomCode || this._reconnecting) return;
        const ready = this.socket ? this.socket.readyState : -1;
        if (ready === WebSocket.OPEN || ready === WebSocket.CONNECTING) return;
        this._reconnecting = true;
        try {
            await this._rejoinAndConnect();
        } finally {
            this._reconnecting = false;
        }
    }

    async _rejoinAndConnect() {
        const roomCode = this._roomCode;
        if (!roomCode) return;
        const seq = this._navSeq;
        const stale = () => seq !== this._navSeq || this._roomCode !== roomCode;
        const st = pokerState.get();

        try {
            const data = await this._post('/api/room/join', {
                room: roomCode,
                playerId: this._playerId,
                displayName: st.displayName || 'Guest',
                authVersion: 1,
                ...(this._token ? { token: this._token } : {})
            });
            if (stale()) return;
            const me = data.state && (data.state.players || []).find((p) => p.id === this._playerId);
            const seatName = (me && me.displayName) || st.displayName;
            if (data.token) {
                this._token = data.token;
                rememberSeat(roomCode, { playerId: this._playerId, token: this._token, displayName: seatName });
            }
            if (me && me.displayName && me.displayName !== st.displayName) {
                pokerState.set({ displayName: me.displayName });
                saveSession({ roomCode, displayName: me.displayName });
            }
        } catch (e) {
            if (stale()) return;
            // An Origin block or a throttle says nothing about our seat: keep it and keep retrying.
            if (e.status === 429 && this.onError) this.onError(e.message);
            // name_in_use is a rename clash, not a lost seat: keep the seat and keep the socket going.
            const seatProblem = e.code !== 'origin_blocked' && e.code !== 'name_in_use' && e.status !== 429
                && (e.status === 404 || e.status === 403 || e.status === 409);
            if (seatProblem) {
                forgetSeat(roomCode);
                if (e.status === 404) clearLastRoom(roomCode);
                this.leave();
                pokerState.reset();
                if (this.onError) {
                    this.onError(e.status === 404
                        ? 'This room no longer exists.'
                        : 'Your seat could not be restored. Please rejoin.');
                }
                return;
            }
            // Network trouble: fall through, the socket attempt + backoff will keep trying.
        }
        this._connectWS();
    }

    async _post(path, body, { keepalive = false } = {}) {
        incrementUsage();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(`${DEFAULT_WORKER_URL}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
                keepalive
            });
        } catch (e) {
            throw new ApiError('Cannot reach the server. Check your connection.', 0);
        } finally {
            clearTimeout(timeout);
        }

        let data = {};
        try { data = await res.json(); } catch (e) {}

        if (!res.ok) {
            throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data.code, data);
        }
        return data;
    }

    async _get(path) {
        incrementUsage();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(`${DEFAULT_WORKER_URL}${path}`, { signal: controller.signal });
        } catch (e) {
            throw new ApiError('Cannot reach the server. Check your connection.', 0);
        } finally {
            clearTimeout(timeout);
        }
        let data = {};
        try { data = await res.json(); } catch (e) {}
        if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data.code, data);
        return data;
    }

    /** Inactive seats of a room that can be taken over: [{ ref, displayName, inactiveSeconds }] */
    async listSeats(roomCode) {
        const data = await this._get(`/api/room/seats?room=${encodeURIComponent(roomCode.toUpperCase())}`);
        return Array.isArray(data.seats) ? data.seats : [];
    }

    /** Take over an inactive seat (lost token / closed tab). Throws ApiError on failure. */
    async claimSeat(roomCode, seatRef) {
        this.disconnect();
        const seq = ++this._navSeq;
        const code = roomCode.toUpperCase();
        const myId = pokerState.get().myPeerId;

        const saved = getSeat(code);
        const data = await this._post('/api/room/claim', {
            room: code,
            playerId: myId,
            seatRef,
            authVersion: 1,
            ...(saved && saved.token ? { token: saved.token } : {})
        });
        if (seq !== this._navSeq) throw new ApiError('Superseded by a newer request', -1);

        const me = data.state.players.find((p) => p.id === myId);
        this.roomCode = code;
        this._token = data.token || null;
        this._enterRoom(data, code, me ? me.displayName : 'Guest');
        this.connectWebSocket(code, myId);
    }

    /**
     * Create room as Host. Throws ApiError (e.status 409 = code already in use).
     * @param {string} roomCode
     * @param {string} displayName
     */
    async createRoom(roomCode, displayName) {
        this.disconnect();
        const seq = ++this._navSeq;
        const code = roomCode.toUpperCase();
        const name = displayName || 'Host';
        const myId = pokerState.get().myPeerId;

        const data = await this._post('/api/room/create', {
            roomCode: code,
            playerId: myId,
            displayName: name,
            authVersion: 1
        });
        if (seq !== this._navSeq) throw new ApiError('Superseded by a newer request', -1);

        this.roomCode = code;
        this.isHost = true;
        this._token = data.token || null;
        this._enterRoom(data, code, name);
        this.connectWebSocket(code, myId);
    }

    /**
     * Join room as Player (also used to rejoin the same seat after a reload).
     * Throws ApiError when the room is missing/full.
     * @param {string} roomCode
     * @param {string} displayName
     */
    async joinRoom(roomCode, displayName, _retried = false) {
        this.disconnect();
        const seq = ++this._navSeq;
        const code = roomCode.toUpperCase();
        // This browser's saved seat for the room: rejoining is automatic, no questions asked.
        const saved = getSeat(code);
        // The saved token belongs to the id that created the seat: use that id for this room.
        if (saved && saved.playerId && saved.playerId !== pokerState.get().myPeerId) {
            pokerState.setPeerId(saved.playerId);
        }
        const myId = pokerState.get().myPeerId;
        const prevToken = saved ? saved.token : null;

        let data;
        try {
            data = await this._post('/api/room/join', {
                room: code,
                playerId: myId,
                displayName,
                authVersion: 1,
                ...(prevToken ? { token: prevToken } : {})
            });
        } catch (e) {
            if (seq === this._navSeq) {
                if (e.status === 404) {
                    forgetSeat(code);
                    clearSession();
                }
                // Our id is held by a seat whose token we no longer have: switch to a fresh id and let
                // the name decide (an inactive seat with that name is offered as "join back").
                if (e.status === 403 && !e.code && !_retried) {
                    forgetSeat(code);
                    pokerState.rotatePeerId();
                    return this.joinRoom(roomCode, displayName, true);
                }
            }
            throw e;
        }
        if (seq !== this._navSeq) throw new ApiError('Superseded by a newer request', -1);

        this.roomCode = code;
        this._token = data.token || prevToken || null;
        this._enterRoom(data, code, displayName);
        this.connectWebSocket(code, myId);
    }

    _enterRoom(data, roomCode, displayName) {
        const myId = pokerState.get().myPeerId;
        const st = data.state;
        // The server may have given us a variant of the typed name (e.g. "Bob 2"): use what it stored.
        const mine = (st.players || []).find((p) => p.id === myId);
        if (mine && mine.displayName) displayName = mine.displayName;
        saveSession({ roomCode, displayName });
        rememberSeat(roomCode, { playerId: myId, token: this._token, displayName });
        setLastRoom({ roomCode, displayName });
        pokerState.set({
            role: st.hostId === myId ? 'HOST' : 'VOTER',
            roomCode,
            displayName,
            currentStory: st.currentStory,
            deckType: st.deckType,
            roundStatus: st.roundStatus,
            players: st.players,
            votes: st.votes,
            myVote: st.votes && st.votes[myId] !== undefined ? st.votes[myId] : null,
            history: st.history
        });
    }

    /** Establish real-time WebSocket connection to Durable Object */
    connectWebSocket(roomCode, playerId) {
        this._reconnectAttempts = 0;
        this._roomCode = roomCode;
        this._playerId = playerId;
        this._connectWS();
    }

    _connectWS() {
        if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
        try {
            const wsProtocol = DEFAULT_WORKER_URL.startsWith('https') ? 'wss:' : 'ws:';
            const wsHost = DEFAULT_WORKER_URL.replace(/^https?:\/\//, '');
            const wsUrl = `${wsProtocol}//${wsHost}/ws?room=${encodeURIComponent(this._roomCode)}&playerId=${encodeURIComponent(this._playerId)}`;

            const ws = new WebSocket(wsUrl);
            this.socket = ws;

            ws.addEventListener('open', () => {
                if (this.socket !== ws) return;
                console.log('[WebSocket] Connected to Durable Object room:', this._roomCode);
                this._reconnectAttempts = 0;
                // Tokens travel in the first message, never in the URL (URLs end up in logs).
                if (this._token) {
                    ws.send(JSON.stringify({ type: 'auth', payload: { token: this._token } }));
                }
                this.startPing();
            });

            ws.addEventListener('message', (event) => {
                if (this.socket !== ws) return;
                this._lastMessageAt = Date.now();
                try {
                    const msg = JSON.parse(event.data);
                    this.handleServerEvent(msg);
                } catch (e) {}
            });

            ws.addEventListener('close', (event) => {
                // Ignore closes from sockets we already replaced or disconnected.
                if (this.socket !== ws) return;
                this.stopPing();

                if (event.code === CLOSE_REPLACED || event.code === CLOSE_AUTH_FAILED || event.code === CLOSE_EXPIRED) {
                    // Terminal: this tab no longer owns a seat. Go back to the lobby.
                    const room = this._roomCode;
                    const movedAway = /taken over|no longer exists/i.test(event.reason || '');
                    let message = 'Session could not be verified.';
                    if (event.code === CLOSE_REPLACED) {
                        message = 'You opened this room somewhere else, so this tab was disconnected.';
                    } else if (event.code === CLOSE_EXPIRED) {
                        message = 'This room has expired.';
                    } else if (movedAway) {
                        message = 'Someone joined back with your name, so your seat moved to them.';
                    }
                    // Replaced = another tab/device keeps the seat, so its saved token must stay.
                    if (room && event.code === CLOSE_AUTH_FAILED) {
                        forgetSeat(room, this._token); // never wipe a newer token another tab stored
                        clearLastRoom(room);
                    }
                    if (room && event.code === CLOSE_EXPIRED) {
                        forgetSeat(room);
                        clearLastRoom(room);
                    }
                    this.leave();
                    pokerState.reset();
                    if (this.onError) this.onError(message);
                    return;
                }

                // Auto-reconnect with exponential backoff (max 30s)
                if (this._roomCode && this._reconnectAttempts < 10) {
                    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
                    this._reconnectAttempts++;
                    console.warn(`[WebSocket] Closed. Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempts})...`);
                    this._reconnectTimer = setTimeout(() => {
                        this._reconnectTimer = null;
                        // A background tab must not steal the seat back from the tab in use;
                        // it reconnects as soon as it becomes visible (visibilitychange -> resync).
                        if (document.visibilityState === 'hidden') return;
                        this._reconnect();
                    }, delay);
                } else if (this._roomCode && this.onError) {
                    this.onError('Connection lost. Reload the page to reconnect.');
                }
            });

            ws.addEventListener('error', (err) => {
                console.warn('[WebSocket Error]:', err);
            });
        } catch (err) {
            console.warn('[WebSocket Connect Fail]:', err);
        }
    }

    handleServerEvent(msg) {
        const { event, payload } = msg;
        if (!payload) return;

        if (event === 'error') {
            if (!payload.action || payload.action === 'vote') this._revertPendingVote();
            if (this.onError && payload.message) this.onError(payload.message);
            return;
        }

        if (event === 'room_state' || event === 'room_updated') {
            const current = pokerState.get();
            const myId = current.myPeerId;
            if (payload.roomCode) touchLastRoom(payload.roomCode);

            // Own vote comes back un-masked from the server; absent means cleared/not voted.
            let myVote = payload.votes && payload.votes[myId] !== undefined
                ? payload.votes[myId]
                : null;

            this._serverVote = myVote;

            // Someone else's broadcast can arrive before the server applied our vote:
            // keep showing the optimistic vote until the server confirms it.
            if (this._pendingVote) {
                if (myVote === this._pendingVote.value) this._clearPendingVote();
                else myVote = this._pendingVote.value;
            }

            // Role is always derived from the server's host id (survives reloads/reconnects).
            const role = payload.hostId
                ? (payload.hostId === myId ? 'HOST' : 'VOTER')
                : current.role;

            if (this.onNotice && current.role !== 'LOBBY' && current.role !== role) {
                const hostName = ((payload.players || []).find((p) => p.id === payload.hostId) || {}).displayName || 'Another player';
                if (role === 'HOST') {
                    this.onNotice(payload.actingHost
                        ? 'The host is away. You are now the acting host.'
                        : 'You are now the host.');
                } else if (payload.actingHost) {
                    this.onNotice('Another player is now the acting host.');
                } else {
                    // Only "back" when the permanent host is the one who returned; otherwise it was handed over
                    this.onNotice(current.actingHost && payload.hostId === current.homeHostId
                        ? 'The host is back.'
                        : `${hostName} is now the host.`);
                }
            }

            pokerState.set({
                role,
                actingHost: Boolean(payload.actingHost),
                homeHostId: payload.homeHostId || payload.hostId || null,
                roomCode: payload.roomCode || current.roomCode,
                currentStory: payload.currentStory || current.currentStory,
                deckType: payload.deckType || current.deckType,
                roundStatus: payload.roundStatus || current.roundStatus,
                players: payload.players || current.players,
                votes: payload.votes || current.votes,
                myVote,
                history: payload.history || current.history
            });
        }
    }

    sendEvent(type, payload = {}) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            incrementUsage();
            this.socket.send(JSON.stringify({ type, payload }));
        } else if (REST_ACTIONS.has(type)) {
            // REST fallback while the socket is down (never for ping)
            this.sendRESTFallback(type, payload);
        }
    }

    async sendRESTFallback(type, payload) {
        try {
            await this._post(`/api/room/${type}`, {
                room: this.roomCode,
                playerId: pokerState.get().myPeerId,
                ...(this._token ? { token: this._token } : {}),
                ...payload
            });
            this.resync(); // the socket is down: reconnect to receive the resulting state
        } catch (e) {
            if (type === 'vote') this._revertPendingVote();
            if (this.onError) this.onError(e.message || 'Action failed.');
        }
    }

    _revertPendingVote() {
        if (!this._pendingVote) return;
        const prev = this._pendingVote.prev;
        this._clearPendingVote();
        pokerState.set({ myVote: prev });
    }

    _clearPendingVote() {
        if (this._pendingVote && this._pendingVote.timer) clearTimeout(this._pendingVote.timer);
        this._pendingVote = null;
    }

    /** Cast vote */
    submitVote(estimate) {
        const prev = this._pendingVote ? this._pendingVote.prev : pokerState.get().myVote;
        this._clearPendingVote();
        const pending = { prev, value: estimate, timer: null };
        // Safety net: if the server never confirms, fall back to what it last told us.
        pending.timer = setTimeout(() => {
            if (this._pendingVote !== pending) return;
            this._pendingVote = null;
            pokerState.set({ myVote: this._serverVote ?? null });
        }, 4000);
        this._pendingVote = pending;
        pokerState.set({ myVote: estimate });
        this.sendEvent('vote', { vote: estimate });
    }

    /** Host updates story title */
    updateStory(title, description = '') {
        this.sendEvent('story', { title: title.trim(), description: description.trim() });
    }

    /** Host changes deck */
    changeDeck(deckType) {
        this.sendEvent('deck', { deckType });
    }

    /** Host reveals votes */
    revealVotes() {
        this.sendEvent('reveal');
    }

    /** Host resets votes */
    resetVotes() {
        this.sendEvent('reset');
    }

    /** Host hands the host role to another connected player */
    makeHost(targetId) {
        this.sendEvent('make_host', { targetId });
    }

    /** Host saves story estimate */
    saveStoryEstimate(agreedPoints) {
        this.sendEvent('save_story', { agreedPoints });
    }

    startPing() {
        this.stopPing();
        this.pingInterval = setInterval(() => {
            this.sendEvent('ping');
        }, 25000);
    }

    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    disconnect() {
        this._roomCode = null; // Prevents auto-reconnect
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        this.stopPing();
        if (this.socket) {
            const ws = this.socket;
            this.socket = null; // detach first so its close handler is ignored
            ws.close();
        }
    }

    /** Leave the room for good: close everything and forget the saved seat. */
    leave() {
        this.disconnect();
        this._token = null;
        this.roomCode = null;
        this._clearPendingVote();
        clearSession();
    }

    /**
     * Explicit Exit: tell the server so the seat disappears at once (no ghost), then forget it here.
     * (The host keeps the seat on the server so they can come back or hand the role over.)
     */
    async exit() {
        const code = this._roomCode || this.roomCode;
        const playerId = pokerState.get().myPeerId;
        const token = this._token;
        this.leave();
        if (!code) return;
        clearLastRoom(code);
        let result = null;
        try {
            result = await Promise.race([
                this._post('/api/room/leave', { room: code, playerId, ...(token ? { token } : {}) }, { keepalive: true }),
                new Promise((resolve) => setTimeout(resolve, 1500))
            ]);
        } catch (e) {}
        // The server keeps the host's seat, so keep the host's token to walk straight back in.
        if (!(result && result.kept)) forgetSeat(code);
    }
}
