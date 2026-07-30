/**
 * Sprint Planning Poker v2.0 - PokerRoom Durable Object
 * Single authoritative source-of-truth in-memory room instance.
 */

import { sendJSON, broadcastJSON } from './websocket.js';
import { CORS_HEADERS, ROOM_TIMEOUT_MS, MAX_PLAYERS } from './constants.js';

export class PokerRoom {
    constructor(state, env) {
        this.state = state;
        this.env = env;

        // Authoritative Memory State
        this.roomCode = null;
        this.hostId = null;
        this.players = new Map(); // playerId -> { id, displayName, role, joinedAt }
        this.currentStory = {
            title: 'User Story #1',
            description: 'Estimate complexity for this task'
        };
        this.deckType = 'fibonacci';
        this.votes = new Map(); // playerId -> vote string
        this.revealed = false;
        this.history = [];
        this.sockets = new Map(); // playerId -> WebSocket
        this.lastActivity = Date.now();
    }

    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;

        // Update activity timestamp
        this.lastActivity = Date.now();

        // Handle Options CORS Preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        // WebSocket Upgrade Endpoint
        if (path === '/ws' || request.headers.get('Upgrade') === 'websocket') {
            return this.handleWebSocket(request);
        }

        // REST API endpoints routed into Durable Object
        if (path.endsWith('/create')) {
            return this.handleCreate(request);
        } else if (path.endsWith('/join')) {
            return this.handleJoin(request);
        } else if (path.endsWith('/vote')) {
            return this.handleVote(request);
        } else if (path.endsWith('/reveal')) {
            return this.handleReveal(request);
        } else if (path.endsWith('/reset')) {
            return this.handleReset(request);
        } else if (path.endsWith('/story')) {
            return this.handleStory(request);
        } else if (path.endsWith('/state')) {
            return this.handleGetState(request);
        }

        return new Response(JSON.stringify({ error: 'Endpoint not found' }), {
            status: 404,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
    }

    /* ---- REST Handlers ---- */

    async handleCreate(request) {
        const body = await request.json();
        this.roomCode = body.roomCode.toUpperCase();
        this.hostId = body.playerId;
        this.players.clear();
        this.votes.clear();
        this.history = [];
        this.revealed = false;

        this.players.set(body.playerId, {
            id: body.playerId,
            displayName: body.displayName || 'Host',
            role: 'HOST',
            joinedAt: Date.now()
        });

        return new Response(JSON.stringify({
            success: true,
            roomCode: this.roomCode,
            state: this.getSanitizedState(body.playerId)
        }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    async handleJoin(request) {
        const body = await request.json();
        const playerId = body.playerId;
        const displayName = body.displayName.trim();

        if (this.players.size >= MAX_PLAYERS) {
            return new Response(JSON.stringify({ error: 'Room is full' }), {
                status: 400,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
            });
        }

        if (!this.players.has(playerId)) {
            this.players.set(playerId, {
                id: playerId,
                displayName: displayName,
                role: 'VOTER',
                joinedAt: Date.now()
            });
            this.broadcastState();
        }

        return new Response(JSON.stringify({
            success: true,
            roomCode: this.roomCode,
            state: this.getSanitizedState(playerId)
        }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    async handleVote(request) {
        const body = await request.json();
        const { playerId, vote } = body;

        if (vote === null || vote === undefined) {
            this.votes.delete(playerId);
        } else {
            this.votes.set(playerId, String(vote));
        }

        this.broadcastState();

        return new Response(JSON.stringify({ success: true }), {
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
    }

    async handleReveal(request) {
        this.revealed = true;
        this.broadcastState();
        return new Response(JSON.stringify({ success: true }), {
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
    }

    async handleReset(request) {
        this.revealed = false;
        this.votes.clear();
        this.broadcastState();
        return new Response(JSON.stringify({ success: true }), {
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
    }

    async handleStory(request) {
        const body = await request.json();
        this.currentStory = {
            title: body.title || 'User Story #1',
            description: body.description || ''
        };
        this.broadcastState();
        return new Response(JSON.stringify({ success: true }), {
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
    }

    async handleGetState(request) {
        const url = new URL(request.url);
        const playerId = url.searchParams.get('playerId');

        return new Response(JSON.stringify(this.getSanitizedState(playerId)), {
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
    }

    /* ---- WebSocket Lifecycle & Event Handlers ---- */

    async handleWebSocket(request) {
        const url = new URL(request.url);
        const playerId = url.searchParams.get('playerId');
        const displayName = url.searchParams.get('displayName') || 'Guest';

        if (!playerId) {
            return new Response('Missing playerId parameter', { status: 400 });
        }

        const pair = new WebSocketPair();
        const [clientWS, serverWS] = Object.values(pair);

        serverWS.accept();

        // Register player and socket connection
        if (!this.players.has(playerId)) {
            this.players.set(playerId, {
                id: playerId,
                displayName,
                role: this.players.size === 0 ? 'HOST' : 'VOTER',
                joinedAt: Date.now()
            });
        }

        this.sockets.set(playerId, serverWS);

        // Send initial room snapshot to newly connected client
        sendJSON(serverWS, 'room_state', this.getSanitizedState(playerId));
        this.broadcastState();

        serverWS.addEventListener('message', async (event) => {
            try {
                this.lastActivity = Date.now();
                const data = JSON.parse(event.data);
                this.processMessage(playerId, data);
            } catch (err) {
                console.warn('[WS Message Error]:', err);
            }
        });

        serverWS.addEventListener('close', () => {
            this.sockets.delete(playerId);
            this.broadcastState();
        });

        serverWS.addEventListener('error', () => {
            this.sockets.delete(playerId);
        });

        return new Response(null, { status: 101, webSocket: clientWS });
    }

    processMessage(playerId, data) {
        const { type, payload } = data;

        switch (type) {
            case 'ping':
                sendJSON(this.sockets.get(playerId), 'pong');
                break;

            case 'vote':
                if (payload && payload.vote !== undefined) {
                    if (payload.vote === null) {
                        this.votes.delete(playerId);
                    } else {
                        this.votes.set(playerId, String(payload.vote));
                    }
                    this.broadcastState();
                }
                break;

            case 'reveal':
                this.revealed = true;
                this.broadcastState();
                break;

            case 'reset':
                this.revealed = false;
                this.votes.clear();
                this.broadcastState();
                break;

            case 'story':
                if (payload && payload.title) {
                    this.currentStory = {
                        title: payload.title,
                        description: payload.description || ''
                    };
                    this.broadcastState();
                }
                break;

            case 'deck':
                if (payload && payload.deckType) {
                    this.deckType = payload.deckType;
                    this.broadcastState();
                }
                break;

            case 'save_story':
                if (payload && payload.agreedPoints) {
                    const stats = this._calculateStats();
                    this.history.push({
                        title: this.currentStory.title,
                        description: this.currentStory.description,
                        agreedPoints: payload.agreedPoints,
                        stats: stats,
                        timestamp: Date.now()
                    });
                    this.revealed = false;
                    this.votes.clear();
                    this.broadcastState();
                }
                break;
        }
    }

    broadcastState() {
        this.sockets.forEach((socket, pId) => {
            sendJSON(socket, 'room_updated', this.getSanitizedState(pId));
        });
    }

    getSanitizedState(forPlayerId) {
        const votesObj = {};
        this.votes.forEach((val, pId) => {
            if (this.revealed || pId === forPlayerId) {
                votesObj[pId] = val; // Show actual estimate if revealed or own vote
            } else {
                votesObj[pId] = '✓'; // Secret vote indicator
            }
        });

        return {
            roomCode: this.roomCode,
            hostId: this.hostId,
            currentStory: this.currentStory,
            deckType: this.deckType,
            roundStatus: this.revealed ? 'REVEALED' : 'VOTING',
            players: Array.from(this.players.values()),
            votes: votesObj,
            history: this.history,
            totalConnectedSockets: this.sockets.size
        };
    }

    _calculateStats() {
        const vals = Array.from(this.votes.values()).map(Number).filter(n => !isNaN(n));
        if (vals.length === 0) return { average: 0, median: 0, totalVotes: this.votes.size };
        vals.sort((a, b) => a - b);
        const sum = vals.reduce((acc, c) => acc + c, 0);
        const avg = Math.round((sum / vals.length) * 10) / 10;
        const mid = Math.floor(vals.length / 2);
        const med = vals.length % 2 === 0 ? Math.round(((vals[mid - 1] + vals[mid]) / 2) * 10) / 10 : vals[mid];
        return { average: avg, median: med, totalVotes: this.votes.size };
    }
}
