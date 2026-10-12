// A big room: many players, correct statistics, and the 50-player cap.
const { test, expect, request } = require('@playwright/test');
const H = require('./helpers');

async function api() {
    return request.newContext({ baseURL: H.API, extraHTTPHeaders: { Origin: H.ORIGIN, 'Content-Type': 'application/json' } });
}

test('20 players vote: table renders, statistics are exactly right, nothing overflows', async ({ browser }) => {
    test.setTimeout(240_000);
    const host = await H.newUser(browser, 'host');
    const a = await api();
    try {
        const code = await H.createRoom(host.page, 'Hana');
        const cards = ['1', '2', '3', '5', '8'];
        const seats = [];
        for (let i = 0; i < 20; i++) {
            const id = `p_big${i}_${Date.now()}`;
            const j = await a.post('/api/room/join', { data: { room: code, playerId: id, displayName: `Player ${i + 1}`, authVersion: 1 } });
            expect(j.status()).toBe(200);
            seats.push({ id, token: (await j.json()).token, card: cards[i % 5] });
        }
        await expect(host.page.locator('#players-grid .player-seat')).toHaveCount(21);

        for (const s of seats) {
            const v = await a.post('/api/room/vote', { data: { room: code, playerId: s.id, token: s.token, vote: s.card } });
            expect(v.status()).toBe(200);
        }
        await expect(host.page.locator('#players-grid .poker-card-back.voted')).toHaveCount(20);
        // still hidden: every card face shows '?' (player names like "Player 13" are not votes)
        expect(await host.page.locator('#players-grid .poker-card-front').allInnerTexts()).toEqual(Array(21).fill('?'));

        await host.page.click('#btn-reveal');
        // 20 votes: 1,2,3,5,8 x4 -> sum 76 -> average 3.8; 10th and 11th values are both 3 -> median 3
        await expect(host.page.locator('#stat-average')).toHaveText('3.8');
        await expect(host.page.locator('#stat-median')).toHaveText('3');
        await expect(host.page.locator('#stat-consensus')).toContainText(/Range \(1\s*[–-]\s*8\)/);
        await expect(host.page.locator('#dist-chart-container .dist-bar-item')).toHaveCount(5);

        const overflow = await host.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(2);
        await host.page.screenshot({ path: 'recordings/large-room-21-players.png', fullPage: true });
    } finally { await host.context.close(); await a.dispose(); }
});

test('the room holds 50 players and refuses the 51st with a clear message', async () => {
    test.setTimeout(240_000);
    const a = await api();
    try {
        await H.paceCreate();
        const code = 'F' + Math.random().toString(36).slice(2, 6).toUpperCase();
        const c = await a.post('/api/room/create', { data: { roomCode: code, playerId: `p_cap_host_${Date.now()}`, displayName: 'Host', authVersion: 1 } });
        expect(c.status()).toBe(200);
        let last;
        for (let i = 1; i < 50; i++) {                                                   // host + 49 = 50
            last = await a.post('/api/room/join', { data: { room: code, playerId: `p_cap${i}_${Date.now()}`, displayName: `Guest ${i}`, authVersion: 1 } });
            expect(last.status(), `player #${i + 1}`).toBe(200);
        }
        const over = await a.post('/api/room/join', { data: { room: code, playerId: `p_cap_over_${Date.now()}`, displayName: 'One too many', authVersion: 1 } });
        expect(over.status()).toBe(400);
        expect((await over.json()).error).toMatch(/full/i);
    } finally { await a.dispose(); }
});
