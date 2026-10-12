// k6: one realistic planning-poker room with 25 people (1 host + 24 players), over REST + WebSocket.
//   k6 run k6/load-room.js
// Each player joins, connects, votes, and must see the host's reveal. We measure join time,
// WebSocket connect time and how long a vote takes to be confirmed.
import http from 'k6/http';
import ws from 'k6/ws';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = (__ENV.UAT_URL || 'https://sprint-poker-worker-uat.temp66081.workers.dev').replace(/\/$/, '');
const API = (__ENV.API_URL || BASE).replace(/\/$/, '');          // the worker (differs from the page on production)
const ORIGIN = BASE.replace(/^(https?:\/\/[^/]+).*$/, '$1');           // Origin header a browser on the page sends
const WS_BASE = API.replace(/^http/, 'ws');
const PLAYERS = Number(__ENV.PLAYERS || 25);

const joinMs = new Trend('join_ms', true);
const voteConfirmMs = new Trend('vote_confirm_ms', true);
const sawReveal = new Counter('players_that_saw_reveal');
const authed = new Counter('sockets_authenticated');
const wsErrors = new Counter('ws_errors');
const updates = new Counter('room_updates_received');

export const options = {
    scenarios: {
        room: { executor: 'per-vu-iterations', vus: PLAYERS, iterations: 1, maxDuration: '90s' }
    },
    thresholds: {
        join_ms: ['p(95)<2000'],
        ws_connecting: ['p(95)<2500'],
        vote_confirm_ms: ['p(95)<1500'],
        ws_errors: ['count==0'],
        sockets_authenticated: [`count==${PLAYERS}`],
        players_that_saw_reveal: [`count==${PLAYERS}`]
    }
};

const jsonHeaders = { 'Content-Type': 'application/json', Origin: ORIGIN };
const rnd = () => Math.random().toString(36).slice(2, 7).toUpperCase();

export function setup() {
    const code = 'L' + rnd();
    const hostId = 'p_k6host_' + Date.now();
    const r = http.post(`${API}/api/room/create`, JSON.stringify({
        roomCode: code, playerId: hostId, displayName: 'K6 Host', authVersion: 1
    }), { headers: jsonHeaders });
    check(r, { 'host created the room': (x) => x.status === 200 });
    return { code, hostId, hostToken: r.json('token') };
}

export default function (data) {
    const vu = exec.vu.idInTest;
    const isHost = vu === 1;
    let playerId = data.hostId;
    let token = data.hostToken;

    if (!isHost) {
        sleep(Math.random() * 3);                                   // people do not all click at once
        playerId = `p_k6vu${vu}_${Date.now()}`;
        const t0 = Date.now();
        const j = http.post(`${API}/api/room/join`, JSON.stringify({
            room: data.code, playerId, displayName: `K6 Player ${vu}`, authVersion: 1
        }), { headers: jsonHeaders });
        joinMs.add(Date.now() - t0);
        check(j, { 'player joined': (x) => x.status === 200 });
        token = j.json('token');
    }

    const myCard = ['1', '2', '3', '5', '8', '13'][vu % 6];
    let voteSentAt = 0;
    let voteConfirmed = false;
    let revealSeen = false;

    const res = ws.connect(`${WS_BASE}/ws?room=${data.code}&playerId=${playerId}`, { headers: { Origin: ORIGIN } }, (socket) => {
        socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', payload: { token } })));

        socket.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw); } catch (e) { return; }
            if (msg.event === 'room_state') {
                authed.add(1);
                if (!isHost) {
                    socket.setTimeout(() => {                         // vote 3-8s after arriving
                        voteSentAt = Date.now();
                        socket.send(JSON.stringify({ type: 'vote', payload: { vote: myCard } }));
                    }, 3000 + Math.random() * 5000);
                } else {
                    socket.setTimeout(() => socket.send(JSON.stringify({ type: 'reveal', payload: {} })), 18000);   // host reveals at ~18s
                }
            }
            if (msg.event === 'room_updated') {
                updates.add(1);
                const votes = (msg.payload && msg.payload.votes) || {};
                if (voteSentAt && !voteConfirmed && votes[playerId] === myCard) {
                    voteConfirmed = true;
                    voteConfirmMs.add(Date.now() - voteSentAt);
                }
                if (!revealSeen && msg.payload && msg.payload.roundStatus === 'REVEALED') {
                    revealSeen = true;
                    sawReveal.add(1);
                }
            }
            if (msg.event === 'error') wsErrors.add(1);
        });

        socket.on('error', () => wsErrors.add(1));
        socket.setTimeout(() => socket.close(), 26000);              // everyone leaves after ~26s
    });

    check(res, { 'websocket upgrade accepted (101)': (x) => x && x.status === 101 });
    if (!isHost) check(null, { 'own vote confirmed by the server': () => voteConfirmed });
}
