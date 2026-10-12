// k6: 6 rooms at once, 8 people each (48 people + 6 hosts). Rooms must never leak into each other.
// Each room's host runs rounds (reveal / reset); every player votes a value unique to their room and
// must only ever see votes from their own room.
//   k6 run k6/multi-room.js
import http from 'k6/http';
import ws from 'k6/ws';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = (__ENV.UAT_URL || 'https://sprint-poker-worker-uat.temp66081.workers.dev').replace(/\/$/, '');
const API = (__ENV.API_URL || BASE).replace(/\/$/, '');
const ORIGIN = BASE.replace(/^(https?:\/\/[^/]+).*$/, '$1');
const WS = API.replace(/^http/, 'ws');
const ROOMS = 6;
const PER_ROOM = 8;                                                 // 1 host + 7 players

const leaks = new Counter('cross_room_leaks');
const sawReveal = new Counter('players_that_saw_reveal');
const sawSecondRound = new Counter('players_that_saw_second_round');
const voteMs = new Trend('vote_confirm_ms', true);
const errors = new Counter('ws_errors');

export const options = {
    scenarios: { rooms: { executor: 'per-vu-iterations', vus: ROOMS * PER_ROOM, iterations: 1, maxDuration: '120s' } },
    thresholds: {
        cross_room_leaks: ['count==0'],
        players_that_saw_reveal: [`count==${ROOMS * PER_ROOM}`],
        players_that_saw_second_round: [`count==${ROOMS * PER_ROOM}`],
        vote_confirm_ms: ['p(95)<1500'],
        ws_errors: ['count==0']
    }
};

const headers = { 'Content-Type': 'application/json', Origin: ORIGIN };
const CARDS = ['1', '2', '3', '5', '8', '13'];            // each room only ever uses ONE of these

export function setup() {
    const rooms = [];
    for (let i = 0; i < ROOMS; i++) {                      // 6 creations: inside the 10-per-minute limit
        const code = 'R' + Math.random().toString(36).slice(2, 5).toUpperCase() + i;
        const hostId = `p_k6mr_host${i}_${Date.now()}`;
        const r = http.post(`${API}/api/room/create`, JSON.stringify({ roomCode: code, playerId: hostId, displayName: `Host ${i}`, authVersion: 1 }), { headers });
        check(r, { 'room created': (x) => x.status === 200 });
        rooms.push({ code, hostId, hostToken: r.json('token'), card: CARDS[i] });
    }
    return { rooms };
}

export default function (data) {
    const vu = exec.vu.idInTest - 1;
    const roomIdx = vu % ROOMS;
    const isHost = vu < ROOMS;
    const room = data.rooms[roomIdx];
    const foreignCards = CARDS.filter((c) => c !== room.card);

    let playerId = room.hostId;
    let token = room.hostToken;
    if (!isHost) {
        playerId = `p_k6mr_${vu}_${Date.now()}`;
        const j = http.post(`${API}/api/room/join`, JSON.stringify({ room: room.code, playerId, displayName: `R${roomIdx} P${vu}`, authVersion: 1 }), { headers });
        check(j, { 'player joined': (x) => x.status === 200 });
        token = j.json('token');
    }

    let sentAt = 0;
    let confirmed = false;
    let revealed = false;
    let secondRound = false;
    ws.connect(`${WS}/ws?room=${room.code}&playerId=${playerId}`, { headers: { Origin: ORIGIN } }, (socket) => {
        socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', payload: { token } })));
        socket.on('message', (raw) => {
            let m; try { m = JSON.parse(raw); } catch (e) { return; }
            if (m.event === 'error') errors.add(1);
            if (m.event === 'room_state') {
                socket.setTimeout(() => { sentAt = Date.now(); socket.send(JSON.stringify({ type: 'vote', payload: { vote: room.card } })); }, 4000 + Math.random() * 3000);
                if (isHost) {
                    socket.setTimeout(() => socket.send(JSON.stringify({ type: 'reveal', payload: {} })), 14000);
                    socket.setTimeout(() => socket.send(JSON.stringify({ type: 'reset', payload: {} })), 20000);
                }
            }
            if (m.event === 'room_updated' && m.payload) {
                const votes = m.payload.votes || {};
                // players of this room only ever see THIS room's card value, and only once revealed
                if (m.payload.roundStatus === 'REVEALED') {
                    revealed = true;
                    for (const id of Object.keys(votes)) if (foreignCards.includes(votes[id])) leaks.add(1);
                }
                if (votes[playerId] === room.card && !confirmed) { confirmed = true; voteMs.add(Date.now() - sentAt); }
                const names = (m.payload.players || []).map((p) => p.displayName);
                for (const n of names) if (n !== `Host ${roomIdx}` && !n.startsWith(`R${roomIdx} `)) leaks.add(1);     // someone from another room?
                if (revealed && m.payload.roundStatus === 'VOTING') secondRound = true;
            }
        });
        socket.on('error', () => errors.add(1));
        socket.setTimeout(() => socket.close(), 26000);
    });
    if (revealed) sawReveal.add(1);
    if (secondRound) sawSecondRound.add(1);
}
