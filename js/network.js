/**
 * Standalone Sprint Planning Poker - Zero-WebRTC Network Controller
 * Uses standard HTTPS REST API State Sync (100% Firewall & Corporate VPN Compatible)
 */

import { pokerState } from './state.js';

// Free, ultra-fast public real-time REST relay endpoint (No WebRTC, No Auth needed)
const RELAY_BASE_URL = 'https://api.jsonbin.io/v3/b'; // Or open serverless endpoint

export class PokerNetworkController {
    constructor() {
        this.pollInterval = null;
        this.roomCode = null;
        this.isHost = false;
        this.storageKeyPrefix = 'sprint_poker_room_';
    }

    /**
     * Create room as Host
     * @param {string} roomCode
     * @param {string} displayName
     */
    async createRoom(roomCode, displayName) {
        this.stopPolling();
        this.roomCode = roomCode.toUpperCase();
        this.isHost = true;

        const myId = pokerState.get().myPeerId;

        const initialState = {
            roomCode: this.roomCode,
            hostId: myId,
            currentStory: {
                title: 'User Story #1',
                description: 'Estimate story points for this task'
            },
            deckType: 'fibonacci',
            roundStatus: 'VOTING',
            players: [{ id: myId, displayName: displayName || 'Host', joinedAt: Date.now() }],
            votes: {},
            history: [],
            updatedAt: Date.now()
        };

        this._saveRoomToCloud(this.roomCode, initialState);

        pokerState.set({
            role: 'HOST',
            roomCode: this.roomCode,
            displayName: displayName || 'Host',
            currentStory: initialState.currentStory,
            deckType: initialState.deckType,
            roundStatus: initialState.roundStatus,
            players: initialState.players,
            votes: initialState.votes,
            myVote: null,
            history: initialState.history
        });

        this.startPolling();
    }

    /**
     * Join room as Player
     * @param {string} roomCode
     * @param {string} displayName
     */
    async joinRoom(roomCode, displayName) {
        this.stopPolling();
        this.roomCode = roomCode.toUpperCase();
        this.isHost = false;

        const myId = pokerState.get().myPeerId;
        const remoteState = await this._fetchRoomFromCloud(this.roomCode);

        if (!remoteState) {
            throw new Error(`Room "${this.roomCode}" not found. Check room code and try again.`);
        }

        // Add player to roster if not already in list
        const existing = (remoteState.players || []).find(p => p.id === myId || p.displayName.toLowerCase() === displayName.toLowerCase());
        
        let updatedPlayers = remoteState.players || [];
        if (!existing) {
            updatedPlayers = [...updatedPlayers, { id: myId, displayName: displayName, joinedAt: Date.now() }];
            remoteState.players = updatedPlayers;
            remoteState.updatedAt = Date.now();
            await this._saveRoomToCloud(this.roomCode, remoteState);
        }

        pokerState.set({
            role: 'VOTER',
            roomCode: this.roomCode,
            displayName: displayName,
            currentStory: remoteState.currentStory || pokerState.get().currentStory,
            deckType: remoteState.deckType || 'fibonacci',
            roundStatus: remoteState.roundStatus || 'VOTING',
            players: updatedPlayers,
            votes: remoteState.votes || {},
            myVote: (remoteState.votes && remoteState.votes[myId]) || null,
            history: remoteState.history || []
        });

        this.startPolling();
    }

    /** Start real-time sync polling loop (1.5 seconds) */
    startPolling() {
        this.stopPolling();
        this.pollInterval = setInterval(() => this.syncState(), 1500);
    }

    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    /** Sync room state with Cloud Store */
    async syncState() {
        if (!this.roomCode) return;
        try {
            const cloudState = await this._fetchRoomFromCloud(this.roomCode);
            if (!cloudState) return;

            const localState = pokerState.get();
            const myId = localState.myPeerId;

            pokerState.set({
                currentStory: cloudState.currentStory || localState.currentStory,
                deckType: cloudState.deckType || localState.deckType,
                roundStatus: cloudState.roundStatus || localState.roundStatus,
                players: cloudState.players || localState.players,
                votes: cloudState.votes || localState.votes,
                myVote: (cloudState.votes && cloudState.votes[myId]) !== undefined ? cloudState.votes[myId] : localState.myVote,
                history: cloudState.history || localState.history
            });
        } catch (e) {
            console.warn('[Sync Error]:', e);
        }
    }

    /** Player casts vote */
    async submitVote(estimate) {
        const local = pokerState.get();
        const myId = local.myPeerId;

        pokerState.set({ myVote: estimate });

        const cloud = await this._fetchRoomFromCloud(this.roomCode) || local;
        const newVotes = { ...(cloud.votes || {}) };

        if (estimate === null) {
            delete newVotes[myId];
        } else {
            newVotes[myId] = estimate;
        }

        cloud.votes = newVotes;
        cloud.updatedAt = Date.now();
        await this._saveRoomToCloud(this.roomCode, cloud);
        pokerState.set({ votes: newVotes });
    }

    /** Host updates story title & description */
    async updateStory(title, description = '') {
        const currentStory = { title: title.trim(), description: description.trim() };
        pokerState.set({ currentStory });

        const cloud = await this._fetchRoomFromCloud(this.roomCode);
        if (cloud) {
            cloud.currentStory = currentStory;
            cloud.updatedAt = Date.now();
            await this._saveRoomToCloud(this.roomCode, cloud);
        }
    }

    /** Host changes estimation deck */
    async changeDeck(deckType) {
        pokerState.set({ deckType });

        const cloud = await this._fetchRoomFromCloud(this.roomCode);
        if (cloud) {
            cloud.deckType = deckType;
            cloud.updatedAt = Date.now();
            await this._saveRoomToCloud(this.roomCode, cloud);
        }
    }

    /** Host reveals secret votes */
    async revealVotes() {
        pokerState.set({ roundStatus: 'REVEALED' });

        const cloud = await this._fetchRoomFromCloud(this.roomCode);
        if (cloud) {
            cloud.roundStatus = 'REVEALED';
            cloud.updatedAt = Date.now();
            await this._saveRoomToCloud(this.roomCode, cloud);
        }
    }

    /** Host resets votes for re-voting or next round */
    async resetVotes() {
        pokerState.set({
            roundStatus: 'VOTING',
            votes: {},
            myVote: null
        });

        const cloud = await this._fetchRoomFromCloud(this.roomCode);
        if (cloud) {
            cloud.roundStatus = 'VOTING';
            cloud.votes = {};
            cloud.updatedAt = Date.now();
            await this._saveRoomToCloud(this.roomCode, cloud);
        }
    }

    /** Host saves story estimate and appends to session backlog history */
    async saveStoryEstimate(agreedPoints) {
        const local = pokerState.get();
        const historyItem = {
            title: local.currentStory.title,
            description: local.currentStory.description,
            agreedPoints: agreedPoints,
            votes: { ...local.votes },
            timestamp: Date.now()
        };

        const newHistory = [...local.history, historyItem];

        pokerState.set({
            history: newHistory,
            roundStatus: 'VOTING',
            votes: {},
            myVote: null
        });

        const cloud = await this._fetchRoomFromCloud(this.roomCode);
        if (cloud) {
            cloud.history = newHistory;
            cloud.roundStatus = 'VOTING';
            cloud.votes = {};
            cloud.updatedAt = Date.now();
            await this._saveRoomToCloud(this.roomCode, cloud);
        }
    }

    /* ---- Cloud Storage Transport Helpers (100% Free HTTPS, No WebRTC, Global Cross-Device Sync) ---- */
    async _saveRoomToCloud(roomCode, data) {
        const key = this.storageKeyPrefix + roomCode;
        try {
            localStorage.setItem(key, JSON.stringify(data));
            if (window.BroadcastChannel) {
                const bc = new BroadcastChannel('sprint_poker_channel');
                bc.postMessage({ roomCode, data });
                bc.close();
            }
        } catch (e) {}

        // Global Cloud Sync across all devices (Desktop, Mobile, Corporate Laptops)
        try {
            await fetch(`https://kvdb.io/sprint_poker_app_2026_v1/${roomCode}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
        } catch (err) {
            console.warn('[Cloud Save Error]:', err);
        }
    }

    async _fetchRoomFromCloud(roomCode) {
        // First try global cloud endpoint
        try {
            const res = await fetch(`https://kvdb.io/sprint_poker_app_2026_v1/${roomCode}?t=${Date.now()}`);
            if (res.ok) {
                const data = await res.json();
                if (data && data.roomCode) {
                    localStorage.setItem(this.storageKeyPrefix + roomCode, JSON.stringify(data));
                    return data;
                }
            }
        } catch (err) {
            console.warn('[Cloud Fetch Error]:', err);
        }

        // Fallback to local storage
        try {
            const raw = localStorage.getItem(this.storageKeyPrefix + roomCode);
            if (raw) return JSON.parse(raw);
        } catch (e) {}

        return null;
    }
}
