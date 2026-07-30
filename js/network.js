/**
 * Standalone Sprint Planning Poker v2.0 - Network Controller
 * Supports Cloudflare Workers + Durable Objects WebSocket Architecture (Port 443)
 * Zero WebRTC, Zero Race Conditions, 100% Corporate Firewall Compatible
 */

import { pokerState } from './state.js';
import { incrementUsage } from './usage.js';

// Default worker URL or relative route if hosted on worker
const DEFAULT_WORKER_URL = window.WORKER_URL || 'https://sprint-poker-worker.workers.dev';

export class PokerNetworkController {
    constructor() {
        this.socket = null;
        this.roomCode = null;
        this.isHost = false;
        this.pingInterval = null;
        this.storageKeyPrefix = 'sprint_poker_room_';
    }

    /**
     * Create room as Host
     * @param {string} roomCode
     * @param {string} displayName
     */
    async createRoom(roomCode, displayName) {
        this.disconnect();
        this.roomCode = roomCode.toUpperCase();
        this.isHost = true;

        const myId = pokerState.get().myPeerId;

        // Try Worker HTTP REST Create first
        try {
            incrementUsage();
            const res = await fetch(`${DEFAULT_WORKER_URL}/api/room/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    roomCode: this.roomCode,
                    playerId: myId,
                    displayName: displayName || 'Host'
                })
            });

            if (res.ok) {
                const data = await res.json();
                if (data && data.state) {
                    pokerState.set({
                        role: 'HOST',
                        roomCode: this.roomCode,
                        displayName: displayName || 'Host',
                        currentStory: data.state.currentStory,
                        deckType: data.state.deckType,
                        roundStatus: data.state.roundStatus,
                        players: data.state.players,
                        votes: data.state.votes,
                        history: data.state.history
                    });
                }
            }
        } catch (e) {
            console.warn('[Worker Create Fallback]:', e);
        }

        // Connect WebSocket stream to Durable Object
        this.connectWebSocket(this.roomCode, myId, displayName || 'Host');
    }

    /**
     * Join room as Player
     * @param {string} roomCode
     * @param {string} displayName
     */
    async joinRoom(roomCode, displayName) {
        this.disconnect();
        this.roomCode = roomCode.toUpperCase();
        this.isHost = false;

        const myId = pokerState.get().myPeerId;

        // Try Worker HTTP REST Join
        try {
            incrementUsage();
            const res = await fetch(`${DEFAULT_WORKER_URL}/api/room/join`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    room: this.roomCode,
                    playerId: myId,
                    displayName: displayName
                })
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || `Room "${this.roomCode}" not found.`);
            }

            const data = await res.json();
            pokerState.set({
                role: 'VOTER',
                roomCode: this.roomCode,
                displayName: displayName,
                currentStory: data.state.currentStory,
                deckType: data.state.deckType,
                roundStatus: data.state.roundStatus,
                players: data.state.players,
                votes: data.state.votes,
                history: data.state.history
            });
        } catch (e) {
            console.warn('[Worker Join Fallback]:', e);
        }

        // Connect WebSocket stream to Durable Object
        this.connectWebSocket(this.roomCode, myId, displayName);
    }

    /** Establish real-time WebSocket connection to Durable Object */
    connectWebSocket(roomCode, playerId, displayName) {
        this._reconnectAttempts = 0;
        this._roomCode = roomCode;
        this._playerId = playerId;
        this._displayName = displayName;
        this._connectWS();
    }

    _connectWS() {
        try {
            const wsProtocol = DEFAULT_WORKER_URL.startsWith('https') ? 'wss:' : 'ws:';
            const wsHost = DEFAULT_WORKER_URL.replace(/^https?:\/\//, '');
            const wsUrl = `${wsProtocol}//${wsHost}/ws?room=${this._roomCode}&playerId=${this._playerId}&displayName=${encodeURIComponent(this._displayName)}`;

            this.socket = new WebSocket(wsUrl);

            this.socket.addEventListener('open', () => {
                console.log('[WebSocket] Connected to Durable Object room:', this._roomCode);
                this._reconnectAttempts = 0;
                this.startPing();
            });

            this.socket.addEventListener('message', (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    this.handleServerEvent(msg);
                } catch (e) {}
            });

            this.socket.addEventListener('close', () => {
                this.stopPing();
                // Auto-reconnect with exponential backoff (max 30s)
                if (this._roomCode && this._reconnectAttempts < 10) {
                    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
                    this._reconnectAttempts++;
                    console.warn(`[WebSocket] Closed. Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempts})...`);
                    this._reconnectTimer = setTimeout(() => this._connectWS(), delay);
                }
            });

            this.socket.addEventListener('error', (err) => {
                console.warn('[WebSocket Error]:', err);
            });
        } catch (err) {
            console.warn('[WebSocket Connect Fail]:', err);
        }
    }

    handleServerEvent(msg) {
        const { event, payload } = msg;
        if (!payload) return;

        if (event === 'room_state' || event === 'room_updated') {
            const myId = pokerState.get().myPeerId;

            // Determine myVote: use server value if present, null if votes were cleared (reset)
            let myVote;
            if (payload.votes && payload.votes[myId] !== undefined) {
                myVote = payload.votes[myId];
            } else {
                myVote = null; // Votes were cleared (reset) or player hasn't voted
            }

            pokerState.set({
                currentStory: payload.currentStory || pokerState.get().currentStory,
                deckType: payload.deckType || pokerState.get().deckType,
                roundStatus: payload.roundStatus || pokerState.get().roundStatus,
                players: payload.players || pokerState.get().players,
                votes: payload.votes || pokerState.get().votes,
                myVote: myVote,
                history: payload.history || pokerState.get().history
            });
        }
    }

    sendEvent(type, payload = {}) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            incrementUsage();
            this.socket.send(JSON.stringify({ type, payload }));
        } else {
            // REST Fallback for vote/reveal/reset
            this.sendRESTFallback(type, payload);
        }
    }

    async sendRESTFallback(type, payload) {
        try {
            incrementUsage();
            const myId = pokerState.get().myPeerId;
            await fetch(`${DEFAULT_WORKER_URL}/api/room/${type}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    room: this.roomCode,
                    playerId: myId,
                    ...payload
                })
            });
        } catch (e) {}
    }

    /** Cast vote */
    submitVote(estimate) {
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
            this.socket.close();
            this.socket = null;
        }
    }
}
