// The API contract, tested from the outside with deliberately bad requests, plus raw WebSocket behaviour.
const { test, expect, request } = require('@playwright/test');
const H = require('./helpers');

const T = Date.now();
let seq = 0;
const uid = (p) => `${p}${T}${seq++}`;
const rcode = () => 'C' + Math.random().toString(36).slice(2, 6).toUpperCase();

async function api(origin = H.ORIGIN) {
    return request.newContext({ baseURL: H.API, extraHTTPHeaders: { ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' } });
}

let a;          // API client with the allowed Origin
let room;       // one room shared by the tests below
const host = { id: uid('p_c_host'), token: null };
const ann = { id: uid('p_c_ann'), token: null };

test.beforeAll(async () => {
    a = await api();
    await H.paceCreate();
    room = rcode();
    const c = await a.post('/api/room/create', { data: { roomCode: room, playerId: host.id, displayName: 'Hana', authVersion: 1 } });
    expect(c.status()).toBe(200);
    host.token = (await c.json()).token;
    const j = await a.post('/api/room/join', { data: { room, playerId: ann.id, displayName: 'Ann', authVersion: 1 } });
    ann.token = (await j.json()).token;
});
test.afterAll(async () => { await a.dispose(); });

const post = (path, data) => a.post(path, { data });

test('malformed input is rejected cleanly (never a 500)', async () => {
    const raw = (path, body, method = 'POST') => a.fetch(path, { method, data: body, headers: { 'Content-Type': 'application/json' } });
    expect((await raw('/api/room/create', '{not json')).status()).toBe(400);
    expect((await raw('/api/room/join', '[]')).status()).toBe(400);
    expect((await raw('/api/room/join', '"just a string"')).status()).toBe(400);
    expect((await post('/api/room/create', { roomCode: 'a/b!', playerId: uid('p_x') })).status()).toBe(400);
    expect((await post('/api/room/create', { roomCode: 'AB', playerId: uid('p_x') })).status()).toBe(400);          // too short
    expect((await post('/api/room/create', { roomCode: 'ABCDEFGHI', playerId: uid('p_x') })).status()).toBe(400);   // too long
    expect((await post('/api/room/join', { room, playerId: '', displayName: 'X' })).status()).toBe(400);
    expect((await post('/api/room/join', { room, playerId: 'bad id with spaces', displayName: 'X' })).status()).toBe(400);
    expect((await post('/api/room/join', { room: 'ZZZZ99', playerId: uid('p_x'), displayName: 'X' })).status()).toBe(404);
    expect((await post('/api/room/vote', { room, playerId: ann.id })).status()).toBe(403);                           // no token
    expect((await post('/api/room/vote', { room: 'bad code', playerId: ann.id })).status()).toBe(400);
});

test('wrong method or unknown route gets the right status', async () => {
    expect((await a.get('/api/room/create')).status()).toBe(405);
    expect((await a.get('/api/room/vote')).status()).toBe(405);          // a POST-only route
    expect((await post('/api/room/state', {})).status()).toBe(405);
    expect((await a.get('/api/room/ping')).status()).toBe(404);
    expect((await a.get('/api/nothing')).status()).toBe(404);
    expect((await a.get('/ws?room=' + room)).status()).toBe(426);        // WebSocket route without an upgrade
});

test('inputs are cleaned: control characters, long text, spacing', async () => {
    const id = uid('p_c_clean');
    const j = await post('/api/room/join', { room, playerId: id, displayName: '  Bo\u0000b\u0007   the   Builder with a name that is far too long  ', authVersion: 1 });
    expect(j.status()).toBe(200);
    const name = (await j.json()).state.players.find((p) => p.id === id).displayName;
    expect(name.length).toBeLessThanOrEqual(30);
    expect(name).not.toMatch(/[\u0000-\u001f]/);
    expect(name).not.toMatch(/\s{2,}/);

    const tok = (await j.json()).token;
    // story title/description limits are enforced by the server for the host
    const longTitle = 'T'.repeat(500);
    const story = await post('/api/room/story', { room, playerId: host.id, token: host.token, title: longTitle, description: 'D'.repeat(900) });
    expect(story.status()).toBe(200);
    const s = await (await a.get(`/api/room/state?room=${room}`)).json();
    expect(s.currentStory.title.length).toBe(120);
    expect(s.currentStory.description.length).toBe(500);
    await post('/api/room/leave', { room, playerId: id, token: tok });
});

test('game rules: only real cards, host-only actions, locks, and deck/vote bookkeeping', async () => {
    const vote = (v, who = ann) => post('/api/room/vote', { room, playerId: who.id, token: who.token, vote: v });
    expect((await vote('999')).status()).toBe(400);                       // not a card in this deck
    expect((await vote('<script>')).status()).toBe(400);
    expect((await vote('✓')).status()).toBe(400);                         // the "hidden" marker is not a card
    expect((await vote('8')).status()).toBe(200);

    // non-host cannot do host things
    for (const [path, data] of [['reveal', {}], ['reset', {}], ['story', { title: 'x' }], ['deck', { deckType: 'tshirt' }], ['make_host', { targetId: host.id }]]) {
        const r = await post(`/api/room/${path}`, { room, playerId: ann.id, token: ann.token, ...data });
        expect(r.status(), `${path} by a voter`).toBe(403);
    }
    // host-only validation
    const hostDo = (path, data) => post(`/api/room/${path}`, { room, playerId: host.id, token: host.token, ...data });
    expect((await hostDo('story', { title: '   ' })).status()).toBe(400);
    expect((await hostDo('deck', { deckType: 'nope' })).status()).toBe(400);
    expect((await hostDo('make_host', { targetId: 'p_nobody_here' })).status()).toBe(404);
    expect((await hostDo('make_host', { targetId: host.id })).status()).toBe(400);     // already the host
    expect((await hostDo('make_host', { targetId: ann.id })).status()).toBe(409);      // Ann is not connected right now
    expect((await hostDo('save_story', { agreedPoints: '5' })).status()).toBe(409);    // not revealed yet

    expect((await hostDo('reveal', {})).status()).toBe(200);
    expect((await vote('5')).status()).toBe(409);                         // votes lock after reveal
    expect((await hostDo('save_story', { agreedPoints: '' })).status()).toBe(400);
    expect((await hostDo('save_story', { agreedPoints: '8' })).status()).toBe(200);    // saves and starts the next round
    const s = await (await a.get(`/api/room/state?room=${room}`)).json();
    expect(s.roundStatus).toBe('VOTING');
});

test('privacy: the public state shows no votes, ids or tokens', async () => {
    await post('/api/room/vote', { room, playerId: ann.id, token: ann.token, vote: '13' });
    const raw = await (await a.get(`/api/room/state?room=${room}`)).text();
    expect(raw).not.toContain(ann.id);
    expect(raw).not.toContain(host.id);
    expect(raw).not.toContain(ann.token);
    expect(JSON.parse(raw).votes).toBeUndefined();
    const seats = await (await a.get(`/api/room/seats?room=${room}`)).text();
    expect(seats).not.toContain(ann.id);
    expect(seats).not.toContain(host.token);
});

test('names and seats: unique names, join-back offer, claim rules', async () => {
    const join = (id, name, extra = {}) => post('/api/room/join', { room, playerId: id, displayName: name, authVersion: 1, ...extra });
    const r = await join(uid('p_c_dup'), ' aNN ');                          // Ann is online? (no socket) -> inactive after a while
    // Ann has no socket, so her seat is "inactive" only after ~10s; right now it must at least not allow a plain duplicate join
    expect([409]).toContain(r.status());
    const body = await r.json();
    expect(['name_in_use', 'name_inactive']).toContain(body.code);
    if (body.code === 'name_inactive') {
        expect(body.seatName).toBe('Ann');
        expect(JSON.stringify(body)).not.toContain(ann.id);
    }
    // a bogus or missing claim never succeeds
    expect((await post('/api/room/claim', { room, playerId: uid('p_x'), seatRef: 'zz', authVersion: 1 })).status()).toBe(400);
    expect((await post('/api/room/claim', { room, playerId: uid('p_x'), seatRef: '0123456789abcdef', authVersion: 1 })).status()).toBe(404);
    expect((await post('/api/room/claim', { room, playerId: uid('p_x'), seatRef: '0123456789abcdef' })).status()).toBe(400);   // old client format
});

test.describe('raw WebSocket behaviour (opened from a real page)', () => {
    const wsBase = () => H.API.replace(/^http/, 'ws');

    async function open(page, id, { auth } = {}) {
        return page.evaluate(({ url, auth }) => new Promise((resolve) => {
            const ws = new WebSocket(url);
            const out = { opened: false, closed: null, messages: [] };
            ws.onopen = () => { out.opened = true; if (auth) ws.send(JSON.stringify({ type: 'auth', payload: { token: auth } })); };
            ws.onmessage = (e) => out.messages.push(JSON.parse(e.data).event);
            ws.onclose = (e) => { out.closed = e.code; };
            window.__ws = ws; window.__out = out;
            setTimeout(() => resolve(), 1200);
        }), { url: `${wsBase()}/ws?room=${room}&playerId=${id}`, auth });
    }
    const state = (page) => page.evaluate(() => ({ ...window.__out, readyState: window.__ws.readyState }));

    test('no token = no data; wrong token is closed; right token gets the state', async ({ browser }) => {
        const u = await H.newUser(browser, 'ws');
        try {
            await H.openSite(u.page);
            await open(u.page, ann.id);                                                    // connected but not authenticated
            let s = await state(u.page);
            expect(s.opened).toBe(true);
            expect(s.messages).toEqual([]);                                               // gets nothing
            await u.page.evaluate(() => window.__ws.close());

            await open(u.page, ann.id, { auth: 'deadbeef' });
            s = await state(u.page);
            expect(s.closed).toBe(4003);                                                  // invalid token

            await open(u.page, ann.id, { auth: ann.token });
            s = await state(u.page);
            expect(s.messages).toContain('room_state');
            await u.page.evaluate(() => window.__ws.close());
        } finally { await u.context.close(); }
    });

    test('unknown player and unknown room are refused; oversized and junk messages are ignored', async ({ browser }) => {
        const u = await H.newUser(browser, 'ws2');
        try {
            await H.openSite(u.page);
            await open(u.page, 'p_nobody_9999');
            expect((await state(u.page)).opened).toBe(false);                              // 403 at the upgrade

            const room404 = await u.page.evaluate((url) => new Promise((res) => {
                const ws = new WebSocket(url); ws.onopen = () => res('open'); ws.onerror = () => res('refused'); setTimeout(() => res('timeout'), 3000);
            }), `${wsBase()}/ws?room=NOROOM1&playerId=${ann.id}`);
            expect(room404).toBe('refused');

            await open(u.page, ann.id, { auth: ann.token });
            await u.page.evaluate(() => {
                window.__ws.send('x'.repeat(10000));                                       // far over the size limit
                window.__ws.send('this is not json');
                window.__ws.send(JSON.stringify({ type: 'definitely_not_a_thing', payload: {} }));
            });
            await u.page.waitForTimeout(800);
            let s = await state(u.page);
            expect(s.readyState).toBe(1);                                                  // still connected, nothing crashed
            await u.page.evaluate(() => window.__ws.send(JSON.stringify({ type: 'vote', payload: { vote: '3' } })));
            await u.page.waitForTimeout(800);
            s = await state(u.page);
            expect(s.messages.filter((m) => m === 'room_updated').length).toBeGreaterThan(0);   // and it still works
            await u.page.evaluate(() => window.__ws.close());
        } finally { await u.context.close(); }
    });

    test('a player cannot park unlimited unauthenticated sockets (cap of 3 pending)', async ({ browser }) => {
        const u = await H.newUser(browser, 'ws3');
        try {
            await H.openSite(u.page);
            const result = await u.page.evaluate((url) => new Promise((resolve) => {
                const outcomes = [];
                const socks = [];
                let n = 0;
                const next = () => {
                    if (n === 5) { setTimeout(() => { socks.forEach((s) => s.close()); resolve(outcomes); }, 500); return; }
                    const ws = new WebSocket(url);
                    socks.push(ws);
                    const idx = n++;
                    ws.onopen = () => { outcomes[idx] = 'open'; next(); };
                    ws.onerror = () => { outcomes[idx] = 'refused'; next(); };
                };
                next();
            }), `${wsBase()}/ws?room=${room}&playerId=${ann.id}`);
            expect(result.slice(0, 3)).toEqual(['open', 'open', 'open']);
            expect(result.slice(3)).toContain('refused');
        } finally { await u.context.close(); }
    });
});
