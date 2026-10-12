# UAT tests (Playwright + k6)

These run against the **UAT** deployment, never production:

- UAT URL: `https://sprint-poker-worker-uat.temp66081.workers.dev` (override with the `UAT_URL` env var)
- UAT is its own Cloudflare worker (`sprint-poker-worker-uat`) with its own Durable Objects, serving the frontend itself.
  Deploy it with `cd worker && npm run deploy:uat`.

## Playwright (user flows, security, recording)

```
cd tests/uat
npm install
npx playwright test                      # all specs (~5 min; room creation is paced to respect the 10/min limit)
npx playwright test specs/00-demo.spec.js   # the narrated recording only
npx playwright show-report               # HTML report
```

| Spec | What it proves |
|---|---|
| `00-demo` | Narrated 4-screen walk-through, recorded to `recordings/sprint-poker-uat-demo.mp4` (+ one `.webm` per person) |
| `01-core-flow` | Create, join, hidden votes, reveal, stats, vote lock, save, history, CSV export (`#` in titles) |
| `02-reentry` | Close tab and come back; browser restart; another device joins back by name; online name refused; Exit leaves no ghost; same browser in two rooms; one place at a time |
| `03-host` | Host away -> acting host -> host returns; host hand-over |
| `04-security` | Script injection shown as text; Origin allow-list; cannot vote as someone else or peek at votes; creation rate limit + friendly message + recovery |
| `05-resilience` | Dropped connection recovers; reload keeps seat and vote; QR generated locally; phone-sized screen has no sideways scroll |

## k6 (load and limits)

```
k6 run --summary-export=k6/results/rate-limit.json k6/rate-limit.js   # Origin check + 10 rooms/min/IP limit
k6 run --summary-export=k6/results/load-room.json  k6/load-room.js    # 25 people in one room over WebSocket
k6 run --summary-export=k6/results/probe.json      k6/probe.js        # 1600 probing requests vs the 1000/min throttle
```

Run the rate-limit script when nothing else created rooms in the last minute.

**Free-tier note:** every request counts toward the Cloudflare account's 100,000 requests/day (shared with production).
A full run of everything above uses roughly 5-6 thousand requests.
