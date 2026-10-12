// Browser check for CODE_REVIEW #1: a returning owner who gets a variant name ("Bob 2") must keep the seat
// on later reloads instead of being kicked with "seat could not be restored".
// Needs a local site + worker with short timers (see review-fixes.mjs):
//   cd worker && npx wrangler dev --port 8799 --var GHOST_MS:2000 SEAT_INACTIVE_MS:500 ALLOWED_ORIGINS:http://127.0.0.1:8080
//   (serve a copy of the site whose window.WORKER_URL is http://127.0.0.1:8799 on 127.0.0.1:8080)
//   node tests/uat/local/rename-seat-browser.mjs      (run from tests/uat so @playwright/test resolves)
import { createRequire } from 'module';
const require = createRequire(process.cwd() + '/');
const { chromium } = require('@playwright/test');

const SITE = process.env.SITE || 'http://127.0.0.1:8080/';
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const names = (p) => p.locator('#players-grid .player-name').allTextContents().then((l) => l.map((t) => t.replace(/\s+/g, ' ').trim()));

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = () => browser.newContext({ viewport: { width: 1000, height: 720 } });

// Host
const hostCtx = await ctx(); const host = await hostCtx.newPage();
await host.goto(SITE);
await host.click('#tab-create'); await host.fill('#input-host-name', 'Hana'); await host.click('#btn-create-room');
await host.waitForSelector('#view-room.active');
const code = (await host.textContent('#header-room-code')).trim();

// Bob joins, then closes his tab (keeps his browser profile = his saved seat)
const bobCtx = await ctx(); let bob = await bobCtx.newPage();
await bob.goto(`${SITE}?room=${code}`);
await bob.fill('#input-player-name', 'Bob'); await bob.click('#btn-join-room');
await bob.waitForSelector('#view-room.active');
await bob.close();
await sleep(5000); // seat is pruned

// Carol takes the name Bob
const carolCtx = await ctx(); const carol = await carolCtx.newPage();
await carol.goto(`${SITE}?room=${code}`);
await carol.fill('#input-player-name', 'Bob'); await carol.click('#btn-join-room');
await carol.waitForSelector('#view-room.active');

// Bob comes back in his old profile: auto-resume must give him "Bob 2"
bob = await bobCtx.newPage();
await bob.goto(SITE);
await bob.waitForSelector('#view-room.active', { timeout: 15000 }).catch(() => {});
await sleep(1500);
ok(await bob.locator('#view-room.active').count() === 1, 'returning owner is back in the room');
const seen = await names(host);
ok(seen.some((n) => n.startsWith('Bob 2')), `host sees "Bob 2" (seats: ${seen.join(' | ')})`);

// The bug: the next reload used the stale typed name and got kicked
await bob.reload();
await bob.waitForSelector('#view-room.active', { timeout: 15000 }).catch(() => {});
await sleep(1500);
ok(await bob.locator('#view-room.active').count() === 1, '#1 after a reload Bob is still in the room (not kicked)');
const seen2 = await names(host);
ok(seen2.filter((n) => n.startsWith('Bob 2')).length === 1, `still exactly one "Bob 2" seat (${seen2.join(' | ')})`);
await bob.reload();
await bob.waitForSelector('#view-room.active', { timeout: 15000 }).catch(() => {});
await sleep(1000);
ok(await bob.locator('#view-room.active').count() === 1, '#1 and after a second reload');

await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
