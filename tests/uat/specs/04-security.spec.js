// Security and abuse protection, checked against the deployed UAT worker.
const { test, expect, request } = require('@playwright/test');
const H = require('./helpers');

const closeAll = (...users) => Promise.all(users.map((u) => u.context.close().catch(() => {})));
const rand = () => Math.random().toString(36).slice(2, 7).toUpperCase();

async function api(origin = H.ORIGIN) {
    return request.newContext({
        baseURL: H.API,
        extraHTTPHeaders: origin ? { Origin: origin, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }
    });
}

test('script injection: names and story titles are shown as text, never run', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const good = await api();
    try {
        const code = await H.createRoom(host.page, 'Hana');
        // Bypass the 20-char input limit by calling the API directly with a hostile name
        const res = await good.post('/api/room/join', {
            data: { room: code, playerId: 'p_xss' + Date.now(), displayName: '<img src=x onerror=window.__x=1>', authVersion: 1 }
        });
        expect(res.status()).toBe(200);
        await expect(host.page.locator('#players-grid .player-seat')).toHaveCount(2);
        expect(await host.page.locator('#players-grid img').count()).toBe(0);               // no element was created
        await expect(host.page.locator('#players-grid')).toContainText('<img src=x onerror');   // shown literally
        expect(await host.page.evaluate(() => window.__x)).toBeUndefined();                  // nothing ran
    } finally { await closeAll(host); await good.dispose(); }
});

test('origin check: other websites and missing-origin room creation are refused', async () => {
    const noOrigin = await api(null);
    const evil = await api('https://evil.example.com');
    const good = await api();
    try {
        const body = (extra = {}) => ({ roomCode: 'O' + rand(), playerId: 'p_org' + Date.now(), displayName: 'X', authVersion: 1, ...extra });

        const a = await noOrigin.post('/api/room/create', { data: body() });
        expect(a.status()).toBe(403);
        expect((await a.json()).code).toBe('origin_blocked');

        const b = await evil.post('/api/room/create', { data: body() });
        expect(b.status()).toBe(403);
        expect((await b.json()).code).toBe('origin_blocked');

        expect((await evil.post('/api/room/join', { data: { room: 'ABCD', playerId: 'p_x1234', displayName: 'X' } })).status()).toBe(403);
        expect((await evil.get('/api/room/state?room=ABCD')).status()).toBe(403);
        expect((await evil.fetch('/api/room/create', { method: 'OPTIONS' })).status()).toBe(403);   // browser preflight

        // The real site's origin is accepted (this consumes one room-creation slot)
        await H.paceCreate();
        const ok = await good.post('/api/room/create', { data: body() });
        expect(ok.status()).toBe(200);
    } finally { await Promise.all([noOrigin.dispose(), evil.dispose(), good.dispose()]); }
});

test('nobody can vote as someone else or peek at hidden votes', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const bob = await H.newUser(browser, 'bob');
    const anon = await api();
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.joinRoom(bob.page, code, 'Bob');
        await H.vote(bob.page, '13');
        await expect(host.page.locator('#players-grid .poker-card-back.voted')).toHaveCount(1);

        const players = await host.page.evaluate(async () => {
            const { pokerState } = await import(new URL('js/state.js?v=2.3.0', document.baseURI).href);
            return pokerState.get().players.map((p) => ({ id: p.id, name: p.displayName }));
        });
        const bobId = players.find((p) => p.name === 'Bob').id;

        // Knowing Bob's public id is not enough to act as Bob
        const fake = await anon.post('/api/room/vote', { data: { room: code, playerId: bobId, vote: '1' } });
        expect(fake.status()).toBe(403);
        // A non-host cannot reveal
        const bobReveal = await bob.page.evaluate(async () => {
            const n = window.pokerApp.network;
            n.socket.send(JSON.stringify({ type: 'reveal', payload: {} }));
            return true;
        });
        expect(bobReveal).toBe(true);
        await expect(bob.page.getByText('Only the host can do that')).toBeVisible();
        await expect(host.page.locator('#badge-round-status')).toContainText('VOTING');
        // The public room state never contains votes or player ids
        const state = await (await anon.get(`/api/room/state?room=${code}`)).json();
        expect(JSON.stringify(state)).not.toContain(bobId);
        expect(state.votes).toBeUndefined();
        expect(JSON.stringify(state)).not.toContain('13');
    } finally { await closeAll(host, bob); await anon.dispose(); }
});

test('rate limit: a burst of room creation is cut off with a clear message', async ({ browser }) => {
    test.setTimeout(240_000);
    const good = await api();
    const user = await H.newUser(browser, 'visitor');
    try {
        await H.paceCreate();
        const results = [];
        for (let i = 0; i < 14; i++) {
            const r = await good.post('/api/room/create', {
                data: { roomCode: 'B' + rand(), playerId: 'p_burst' + i + Date.now(), displayName: 'Spam', authVersion: 1 }
            });
            results.push({ status: r.status(), retryAfter: Number(r.headers()['retry-after'] || 0), body: await r.json() });
        }
        const created = results.filter((r) => r.status === 200).length;
        const limited = results.filter((r) => r.status === 429);
        console.log(`burst of 14: ${created} created, ${limited.length} refused (429)`);
        expect(created).toBeLessThanOrEqual(10);
        expect(limited.length).toBeGreaterThanOrEqual(4);
        expect(limited[0].retryAfter).toBeGreaterThan(0);
        expect(limited[0].body.error).toMatch(/Too many rooms/i);

        // A person using the page gets a readable message, and the button works again afterwards
        await H.openSite(user.page);
        await user.page.click('#tab-create');
        await user.page.fill('#input-host-name', 'Hana');
        await user.page.click('#btn-create-room');
        await expect(user.page.getByText(/Too many rooms created from your network/)).toBeVisible();
        await expect(user.page.locator('#view-lobby')).toHaveClass(/active/);
        await expect(user.page.locator('#btn-create-room')).toBeEnabled();

        // Wait out the window: creation works again (the refused requests did not extend the lockout)
        await user.page.waitForTimeout((limited[0].retryAfter + 3) * 1000);
        await user.page.click('#btn-create-room');
        await expect(user.page.locator('#view-room')).toHaveClass(/active/, { timeout: 20_000 });
    } finally { await user.context.close(); await good.dispose(); }
});
