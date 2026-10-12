// k6: general throttle - a burst of probing requests from one IP (limit: 1000 / minute / IP / isolate).
//   k6 run k6/probe.js
// All requests hit ONE nonexistent room code so no extra Durable Objects are created.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = (__ENV.UAT_URL || 'https://sprint-poker-worker-uat.temp66081.workers.dev').replace(/\/$/, '');
const ok404 = new Counter('answered_404');
const throttled = new Counter('throttled_429');

export const options = {
    teardownTimeout: '120s',          // teardown() waits out the 60s throttle window
    scenarios: { burst: { executor: 'per-vu-iterations', vus: 1, iterations: 80, maxDuration: '120s' } }
};

export default function () {
    const reqs = [];
    for (let i = 0; i < 20; i++) reqs.push(['GET', `${BASE}/api/room/state?room=NOROOMK6`, null, { headers: { Origin: BASE } }]);
    const responses = http.batch(reqs);                              // 20 at a time = 1600 requests in total
    for (const r of responses) {
        if (r.status === 404) ok404.add(1);
        if (r.status === 429) throttled.add(1);
    }
}

export function teardown() {
    // Whatever happened in the burst, the client must be served normally again once the window passes.
    sleep(65);
    const r = http.get(`${BASE}/api/room/state?room=NOROOMK6`, { headers: { Origin: BASE } });
    check(r, { 'normal service resumes after the window (404 for the unknown room, not 429)': (x) => x.status === 404 });
}
