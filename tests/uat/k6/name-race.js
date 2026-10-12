// k6: 30 people try to take the SAME name (different capitals/spaces) at the same instant.
// Exactly one may win; everyone else must be refused (409 name_in_use), nobody may get a duplicate seat.
//   k6 run k6/name-race.js        (UAT_URL = page address, API_URL = worker address)
import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = (__ENV.UAT_URL || 'https://sprint-poker-worker-uat.temp66081.workers.dev').replace(/\/$/, '');
const API = (__ENV.API_URL || BASE).replace(/\/$/, '');
const ORIGIN = BASE.replace(/^(https?:\/\/[^/]+).*$/, '$1');
const winners = new Counter('name_winners');
const refused = new Counter('name_refused_409');
const other = new Counter('name_other_status');

export const options = {
    scenarios: { race: { executor: 'shared-iterations', vus: 30, iterations: 30, maxDuration: '60s' } },
    thresholds: { name_winners: ['count==1'], name_refused_409: ['count==29'], name_other_status: ['count==0'] }
};

const headers = { 'Content-Type': 'application/json', Origin: ORIGIN };
const variants = ['Alex', 'alex', 'ALEX', ' Alex ', 'aLeX', 'Alex  ', '  alex'];

export function setup() {
    const code = 'N' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const r = http.post(`${API}/api/room/create`, JSON.stringify({ roomCode: code, playerId: 'p_k6nr_host' + Date.now(), displayName: 'Host', authVersion: 1 }), { headers });
    check(r, { 'room created': (x) => x.status === 200 });
    return { code };
}

export default function (data) {
    const i = exec.scenario.iterationInTest;
    const r = http.post(`${API}/api/room/join`, JSON.stringify({
        room: data.code, playerId: `p_k6nr_${i}_${Date.now()}`, displayName: variants[i % variants.length], authVersion: 1
    }), { headers });
    if (r.status === 200) winners.add(1);
    else if (r.status === 409 && r.json('code') === 'name_in_use') refused.add(1);
    else other.add(1);
}

export function teardown(data) {
    const s = http.get(`${API}/api/room/state?room=${data.code}`, { headers: { Origin: ORIGIN } });
    check(s, { 'public state: host + exactly one Alex': (x) => x.json('playerCount') === 2 });
}
