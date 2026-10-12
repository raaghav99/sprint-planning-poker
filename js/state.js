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
// Browser-wide identity (same key older versions used, so existing users keep their id).
const PEER_ID_KEY = 'sprint_poker_peer_id';
const SEATS_KEY = 'sprint_poker_seats'; // { ROOMCODE: { token, displayName, at } }
const LAST_ROOM_KEY = 'sprint_poker_last_room'; // { roomCode, displayName, at }
const SEAT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const LAST_ROOM_MAX_AGE_MS = 30 * 60 * 1000; // auto-resume only within the same meeting
const MAX_SEATS = 25;
const SESSION_KEY = 'sprint_poker_active_session';
let memoryPeerId = null; // used when localStorage is unavailable

// Storage can throw (blocked cookies, private modes, quota): every access goes through these helpers.
function store(kind) {
    try { return kind === 'session' ? window.sessionStorage : window.localStorage; } catch (e) { return null; }
}

function readJson(kind, key) {
    try {
        const s = store(kind);
        const raw = s && s.getItem(key);
        const value = raw ? JSON.parse(raw) : null;
        return value && typeof value === 'object' ? value : null;
    } catch (e) {
        return null;
    }
}

function writeJson(kind, key, value) {
    try {
        const s = store(kind);
        if (s) s.setItem(key, JSON.stringify(value));
    } catch (e) {}
}

function removeKey(kind, key) {
    try {
        const s = store(kind);
        if (s) s.removeItem(key);
    } catch (e) {}
}

/** Seat per room, kept in localStorage so closing the tab/browser never loses it. */
export function rememberSeat(roomCode, { playerId, token, displayName }) {
    const seats = readJson('local', SEATS_KEY) || {};
    const now = Date.now();
    seats[roomCode] = { playerId: playerId || null, token: token || null, displayName: displayName || '', at: now };
    // Drop stale/corrupt entries and keep the list small
    Object.keys(seats).forEach((code) => {
        const seat = seats[code];
        if (!seat || typeof seat !== 'object' || now - (seat.at || 0) > SEAT_MAX_AGE_MS) delete seats[code];
    });
    const codes = Object.keys(seats).sort((a, b) => seats[b].at - seats[a].at);
    codes.slice(MAX_SEATS).forEach((code) => delete seats[code]);
    writeJson('local', SEATS_KEY, seats);
}

export function getSeat(roomCode) {
    const seats = readJson('local', SEATS_KEY) || {};
    const seat = seats[roomCode];
    return seat && typeof seat === 'object' && Date.now() - (seat.at || 0) <= SEAT_MAX_AGE_MS ? seat : null;
}

/** Forget a room's seat. With `onlyIfToken`, only when the stored token is still that one (another tab may have a newer one). */
export function forgetSeat(roomCode, onlyIfToken) {
    const seats = readJson('local', SEATS_KEY) || {};
    const seat = seats[roomCode];
    if (!seat) return;
    if (onlyIfToken && seat.token !== onlyIfToken) return;
    delete seats[roomCode];
    writeJson('local', SEATS_KEY, seats);
}

/** Last room this browser was in, so a closed browser/tab can resume within the same meeting. */
export function setLastRoom({ roomCode, displayName }) {
    writeJson('local', LAST_ROOM_KEY, { roomCode, displayName, at: Date.now() });
}

/** Refresh the timestamp while the user is active (throttled to once a minute). */
export function touchLastRoom(roomCode) {
    const last = readJson('local', LAST_ROOM_KEY);
    if (last && last.roomCode === roomCode && Date.now() - (last.at || 0) > 60 * 1000) {
        writeJson('local', LAST_ROOM_KEY, { ...last, at: Date.now() });
    }
}

/** Forget the last room, but only the given one (another tab may be active in a different room). */
export function clearLastRoom(roomCode) {
    const last = readJson('local', LAST_ROOM_KEY);
    if (!last) return;
    if (roomCode && last.roomCode !== roomCode) return;
    removeKey('local', LAST_ROOM_KEY);
}

/** Where to go back to on load: this tab's room (reload), else the browser's recent room. */
export function getResumeTarget() {
    const tab = readJson('session', SESSION_KEY);
    if (tab && tab.roomCode) return tab;
    const last = readJson('local', LAST_ROOM_KEY);
    if (last && last.roomCode && Date.now() - (last.at || 0) <= LAST_ROOM_MAX_AGE_MS) return last;
    return null;
}

/** Active room of this tab (survives a reload). */
export function saveSession(session) {
    writeJson('session', SESSION_KEY, session);
}

export function loadSession() {
    return readJson('session', SESSION_KEY);
}

export function clearSession() {
    removeKey('session', SESSION_KEY);
}

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
        this.notify(); // no listeners yet when called from the constructor
    }

    // Browser-wide identity: the same person in the same browser is always the same player, across
    // tabs, restarts and rooms. A different browser/device identifies itself by name instead.
    _getOrGeneratePlayerId() {
        let pid = null;
        try { pid = localStorage.getItem(PEER_ID_KEY); } catch (e) {}
        if (!pid) pid = memoryPeerId;
        if (!pid) {
            pid = 'p_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
            memoryPeerId = pid;
            try { localStorage.setItem(PEER_ID_KEY, pid); } catch (e) {}
        }
        return pid;
    }

    /** Use a given id for this page only (a room's saved seat belongs to the id that created it). */
    setPeerId(id) {
        this.state = { ...this.state, myPeerId: id };
    }

    /** Use a brand-new id (when the old one is locked by a seat we can no longer prove). */
    rotatePeerId() {
        const pid = 'p_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
        memoryPeerId = pid;
        try { localStorage.setItem(PEER_ID_KEY, pid); } catch (e) {}
        this.state = { ...this.state, myPeerId: pid };
    }

    loadSavedUser() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const saved = JSON.parse(raw);
                if (saved.displayName) this.state.displayName = saved.displayName;
            }
        } catch (e) {}
    }

    saveUser() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                displayName: this.state.displayName
            }));
        } catch (e) {}
    }

    get() {
        return this.state;
    }

    set(partialState) {
        this.state = { ...this.state, ...partialState };
        if (partialState.displayName) this.saveUser();
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
