/**
 * Standalone Sprint Planning Poker - State Management & Local Storage Persistence
 */

export const DECKS = {
    fibonacci: {
        name: 'Standard Fibonacci',
        cards: ['0', '0.5', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89', '☕', '❓']
    },
    mod_fibonacci: {
        name: 'Modified Fibonacci',
        cards: ['0', '0.5', '1', '2', '3', '5', '8', '13', '20', '40', '100', '☕', '❓']
    },
    tshirt: {
        name: 'T-Shirt Sizes',
        cards: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '☕', '❓']
    },
    powers2: {
        name: 'Powers of 2',
        cards: ['0', '1', '2', '4', '8', '16', '32', '64', '☕', '❓']
    }
};

const STORAGE_KEY = 'sprint_planning_poker_user_session';

class PokerState {
    constructor() {
        this.listeners = new Set();
        this.reset();
    }

    reset() {
        this.state = {
            role: 'LOBBY', // 'HOST', 'VOTER', 'OBSERVER'
            roomCode: null,
            displayName: '',
            myPeerId: this._getOrGeneratePlayerId(),
            isObserver: false,
            currentStory: {
                title: 'User Story #1',
                description: 'Estimate complexity for this task'
            },
            deckType: 'fibonacci',
            roundStatus: 'VOTING', // 'VOTING', 'REVEALED'
            players: [], // Array of [{ id, displayName, joinedAt }]
            votes: {}, // Map peerId -> estimate card string
            myVote: null,
            history: [] // Array of [{ title, agreedPoints, stats, timestamp }]
        };
        this.loadSavedUser();
    }

    _getOrGeneratePlayerId() {
        let pid = localStorage.getItem('sprint_poker_peer_id');
        if (!pid) {
            pid = 'p_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
            localStorage.setItem('sprint_poker_peer_id', pid);
        }
        return pid;
    }

    loadSavedUser() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const saved = JSON.parse(raw);
                if (saved.displayName) this.state.displayName = saved.displayName;
                if (saved.roomCode) this.state.roomCode = saved.roomCode;
            }
        } catch (e) {}
    }

    saveUser() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                displayName: this.state.displayName,
                roomCode: this.state.roomCode
            }));
        } catch (e) {}
    }

    get() {
        return this.state;
    }

    set(partialState) {
        this.state = { ...this.state, ...partialState };
        if (partialState.displayName || partialState.roomCode) this.saveUser();
        this.notify();
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify() {
        this.listeners.forEach(fn => fn(this.state));
    }
}

export const pokerState = new PokerState();
