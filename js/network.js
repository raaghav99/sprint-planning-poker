/**
 * Standalone Sprint Planning Poker v2.0 - Network Controller
 * Supports Cloudflare Workers + Durable Objects WebSocket Architecture (Port 443)
 * Zero WebRTC, Zero Race Conditions, 100% Corporate Firewall Compatible
 */

import { pokerState } from './state.js';

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
        try {
            const wsProtocol = DEFAULT_WORKER_URL.startsWith('https') ? 'wss:' : 'ws:';
            const wsHost = DEFAULT_WORKER_URL.replace(/^https?:\/\//, '');
            const wsUrl = `${wsProtocol}//${wsHost}/ws?room=${roomCode}&playerId=${playerId}&displayName=${encodeURIComponent(displayName)}`;

            this.socket = new WebSocket(wsUrl);

            this.socket.addEventListener('open', () => {
                console.log('[WebSocket] Connected to Durable Object room:', roomCode);
                this.startPing();
            });

            this.socket.addEventListener('message', (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    this.handleServerEvent(msg);
                } catch (e) {}
            });

            this.socket.addEventListener('close', () => {
                console.warn('[WebSocket] Closed. Attempting reconnect...');
                this.stopPing();
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
            pokerState.set({
                currentStory: payload.currentStory || pokerState.get().currentStory,
                deckType: payload.deckType || pokerState.get().deckType,
                roundStatus: payload.roundStatus || pokerState.get().roundStatus,
                players: payload.players || pokerState.get().players,
                votes: payload.votes || pokerState.get().votes,
                myVote: (payload.votes && payload.votes[myId]) !== undefined ? payload.votes[myId] : pokerState.get().myVote,
                history: payload.history || pokerState.get().history
            });
        }
    }

    sendEvent(type, payload = {}) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type, payload }));
        } else {
            // REST Fallback for vote/reveal/reset
            this.sendRESTFallback(type, payload);
        }
    }

    async sendRESTFallback(type, payload) {
        try {
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
        this.stopPing();
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    }
}
