// k6: Origin allow-list + room-creation rate limit, against the UAT worker.
//   k6 run k6/rate-limit.js            (UAT_URL env var overrides the target)
// Run it when nothing else created rooms in the last minute (the limit is 10 creations / 60s / IP).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = (__ENV.UAT_URL || 'https://sprint-poker-worker-uat.temp66081.workers.dev').replace(/\/$/, '');
const API = (__ENV.API_URL || BASE).replace(/\/$/, '');          // the worker (differs from the page on production)
const ORIGIN = BASE.replace(/^(https?:\/\/[^/]+).*$/, '$1');           // Origin header a browser on the page sends
const roomsCreated = new Counter('rooms_created');
const roomsRefused = new Counter('rooms_refused_429');

export const options = {
    vus: 1,
    iterations: 1,
    // rooms_created > 0 makes the run FAIL if the script crashes before doing anything (0 checks would pass vacuously)
    thresholds: { checks: ['rate==1.0'], rooms_created: ['count>0'] }
};

const rnd = () => Math.random().toString(36).slice(2, 6).toUpperCase();   // 4 chars: 'K' + 4 + up to 3 = max 8
const createBody = (tag) => JSON.stringify({
    roomCode: 'K' + rnd() + tag, playerId: 'p_k6_' + Date.now() + tag, displayName: 'k6', authVersion: 1
});
const json = { 'Content-Type': 'application/json' };

export default function () {
    // ---- Origin allow-list
    let r = http.post(`${API}/api/room/create`, createBody('a'), { headers: json });
    check(r, { 'create without Origin is refused (403 origin_blocked)': (x) => x.status === 403 && x.json('code') === 'origin_blocked' });

    r = http.post(`${API}/api/room/create`, createBody('b'), { headers: { ...json, Origin: 'https://evil.example.com' } });
    check(r, { 'create from another website is refused (403 origin_blocked)': (x) => x.status === 403 && x.json('code') === 'origin_blocked' });

    r = http.get(`${API}/api/room/state?room=ABCD`, { headers: { Origin: 'https://evil.example.com' } });
    check(r, { 'read from another website is refused (403)': (x) => x.status === 403 });

    r = http.options(`${API}/api/room/create`, null, { headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' } });
    check(r, { 'browser preflight from another website is refused (403)': (x) => x.status === 403 });

    // ---- Burst of 20 creations from the real site's origin
    const allowedHeaders = { ...json, Origin: ORIGIN };
    let created = 0;
    let refused = 0;
    let retryAfter = 0;
    let message = '';
    const statuses = {};
    for (let i = 0; i < 20; i++) {
        r = http.post(`${API}/api/room/create`, createBody('c' + i), { headers: allowedHeaders });
        statuses[r.status] = (statuses[r.status] || 0) + 1;
        if (r.status !== 200 && r.status !== 429 && i < 15) console.log(`unexpected ${r.status}: ${String(r.body).slice(0, 160)}`);
        if (r.status === 200) {
            created++;
            roomsCreated.add(1);
        } else if (r.status === 429) {
            refused++;
            roomsRefused.add(1);
            retryAfter = Number(r.headers['Retry-After'] || 0);
            message = r.json('error');
        }
    }
    console.log(`status breakdown: ${JSON.stringify(statuses)}`);
    console.log(`burst of 20 creations: ${created} created, ${refused} refused (429), Retry-After=${retryAfter}s`);
    console.log(`message shown to the user: "${message}"`);
    check(null, {
        'at most 10 rooms were created in the burst': () => created <= 10,
        'the rest were refused with 429': () => created + refused === 20 && refused >= 10,
        'refusals carry Retry-After': () => retryAfter > 0,
        'refusal message is readable': () => /Too many rooms/i.test(message)
    });

    // ---- Refused requests must not extend the lockout: after the window creation works again
    sleep(retryAfter + 3);
    r = http.post(`${API}/api/room/create`, createBody('z'), { headers: allowedHeaders });
    check(r, { 'creation works again after Retry-After': (x) => x.status === 200 });
}
