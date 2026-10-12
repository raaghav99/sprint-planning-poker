// k6: 40 people lose their connection at the same moment and all reconnect (like after a deploy or a wifi outage).
// Every reconnect must succeed, nobody may be throttled or locked out.
//   k6 run k6/reconnect-storm.js
import http from 'k6/http';
import ws from 'k6/ws';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = (__ENV.UAT_URL || 'https://sprint-poker-worker-uat.temp66081.workers.dev').replace(/\/$/, '');
const API = (__ENV.API_URL || BASE).replace(/\/$/, '');
const ORIGIN = BASE.replace(/^(https?:\/\/[^/]+).*$/, '$1');
const WS = API.replace(/^http/, 'ws');
const PEOPLE = Number(__ENV.PEOPLE || 40);

const reconnectOk = new Counter('reconnects_ok');
const rejoinMs = new Trend('rejoin_ms', true);
const throttled = new Counter('throttled_429');
const failed = new Counter('reconnect_failed');

export const options = {
    scenarios: { storm: { executor: 'per-vu-iterations', vus: PEOPLE, iterations: 1, maxDuration: '90s' } },
    thresholds: {
        reconnects_ok: [`count==${PEOPLE * 2}`],          // everyone reconnects twice
        throttled_429: ['count==0'],
        reconnect_failed: ['count==0'],
        rejoin_ms: ['p(95)<2500']
    }
};

const headers = { 'Content-Type': 'application/json', Origin: ORIGIN };

export function setup() {
    const code = 'S' + Math.random().toString(36).slice(2, 6).toUpperCase();
    http.post(`${API}/api/room/create`, JSON.stringify({ roomCode: code, playerId: 'p_k6rs_host' + Date.now(), displayName: 'Host', authVersion: 1 }), { headers });
    return { code };
}

// One session: authenticate, wait, then drop the connection
function session(url, token, holdMs) {
    let gotState = false;
    let stateAfterMs = 0;
    const started = Date.now();
    const res = ws.connect(url, { headers: { Origin: ORIGIN } }, (socket) => {
        socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', payload: { token } })));
        socket.on('message', (raw) => {
            try {
                if (!gotState && JSON.parse(raw).event === 'room_state') { gotState = true; stateAfterMs = Date.now() - started; }
            } catch (e) { /* ignore */ }
        });
        socket.setTimeout(() => socket.close(), holdMs);
    });
    return { ok: !!res && res.status === 101 && gotState, status: res && res.status, stateAfterMs };
}

export default function (data) {
    const vu = exec.vu.idInTest;
    const id = `p_k6rs_${vu}_${Date.now()}`;
    sleep(Math.random() * 2);
    const j = http.post(`${API}/api/room/join`, JSON.stringify({ room: data.code, playerId: id, displayName: `Storm ${vu}`, authVersion: 1 }), { headers });
    if (j.status !== 200) { failed.add(1); return; }
    const token = j.json('token');
    const url = `${WS}/ws?room=${data.code}&playerId=${id}`;

    const first = session(url, token, 6000);                          // everyone is connected for 6s, then all drop together
    if (!first.ok) failed.add(1);

    for (let round = 0; round < 2; round++) {
        sleep(Math.random() * 2.5);                                    // reconnect within a couple of seconds, like the real client
        const t0 = Date.now();
        const rj = http.post(`${API}/api/room/join`, JSON.stringify({ room: data.code, playerId: id, displayName: `Storm ${vu}`, authVersion: 1, token }), { headers });
        if (rj.status === 429) throttled.add(1);
        const joinMs = Date.now() - t0;
        const again = rj.status === 200 ? session(url, token, 2500) : { ok: false };
        if (again.status === 429) throttled.add(1);
        // time until the person is back in the room: the rejoin request + the socket delivering the room state
        rejoinMs.add(joinMs + (again.stateAfterMs || 0));
        if (again.ok) reconnectOk.add(1); else failed.add(1);
    }
}

export function teardown(data) {
    const s = http.get(`${API}/api/room/state?room=${data.code}`, { headers: { Origin: ORIGIN } });
    check(s, { 'every person still has exactly one seat (no duplicates)': (x) => x.json('playerCount') === PEOPLE + 1 });
}
