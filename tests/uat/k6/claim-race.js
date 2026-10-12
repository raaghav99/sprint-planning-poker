// k6: 20 people try to "join back" into the SAME inactive seat at the same instant.
// Exactly one claim may succeed; the seat must not be duplicated or lost.
//   k6 run k6/claim-race.js
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = (__ENV.UAT_URL || 'https://sprint-poker-worker-uat.temp66081.workers.dev').replace(/\/$/, '');
const API = (__ENV.API_URL || BASE).replace(/\/$/, '');
const ORIGIN = BASE.replace(/^(https?:\/\/[^/]+).*$/, '$1');
const won = new Counter('claims_won');
const lost = new Counter('claims_refused');
const unexpected = new Counter('claims_unexpected');

export const options = {
    setupTimeout: '90s',
    scenarios: { race: { executor: 'shared-iterations', vus: 20, iterations: 20, maxDuration: '60s' } },
    thresholds: { claims_won: ['count==1'], claims_refused: ['count==19'], claims_unexpected: ['count==0'] }
};

const headers = { 'Content-Type': 'application/json', Origin: ORIGIN };

export function setup() {
    const code = 'M' + Math.random().toString(36).slice(2, 6).toUpperCase();
    http.post(`${API}/api/room/create`, JSON.stringify({ roomCode: code, playerId: 'p_k6cr_host' + Date.now(), displayName: 'Host', authVersion: 1 }), { headers });
    http.post(`${API}/api/room/join`, JSON.stringify({ room: code, playerId: 'p_k6cr_ann' + Date.now(), displayName: 'Ann', authVersion: 1 }), { headers });
    sleep(12);                                                       // Ann never connected: her seat becomes inactive after ~10s
    const seats = http.get(`${API}/api/room/seats?room=${code}`, { headers: { Origin: ORIGIN } });
    const ann = (seats.json('seats') || []).find((s) => s.displayName === 'Ann');
    check(seats, { 'Ann\'s seat is offered as inactive': () => !!ann });
    return { code, ref: ann && ann.ref };
}

export default function (data) {
    const i = exec.scenario.iterationInTest;
    const r = http.post(`${API}/api/room/claim`, JSON.stringify({
        room: data.code, playerId: `p_k6cr_${i}_${Date.now()}`, seatRef: data.ref, authVersion: 1
    }), { headers });
    if (r.status === 200) won.add(1);
    else if (r.status === 404 || r.status === 409) lost.add(1);
    else unexpected.add(1);
}

export function teardown(data) {
    const s = http.get(`${API}/api/room/state?room=${data.code}`, { headers: { Origin: ORIGIN } });
    check(s, { 'still host + one Ann (no duplicate, nothing lost)': (x) => x.json('playerCount') === 2 });
}
