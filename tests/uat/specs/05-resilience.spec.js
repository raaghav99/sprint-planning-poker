// Connection drops, reloads, and third-party independence.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

const closeAll = (...users) => Promise.all(users.map((u) => u.context.close().catch(() => {})));

test('a dropped connection recovers by itself and updates keep flowing', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const bob = await H.newUser(browser, 'bob');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.joinRoom(bob.page, code, 'Bob');

        await bob.page.evaluate(() => { window.__old = window.pokerApp.network.socket; window.__old.close(); });   // wifi blip
        await bob.page.waitForFunction(() => {
            const s = window.pokerApp.network.socket;
            return s && s !== window.__old && s.readyState === 1;
        }, null, { timeout: 20_000 });

        await H.vote(host.page, '3');                                   // host votes after Bob reconnected
        await expect(bob.page.locator('#players-grid .poker-card-back.voted')).toHaveCount(1, { timeout: 10_000 });
        await H.vote(bob.page, '8');
        await expect(host.page.locator('#players-grid .poker-card-back.voted')).toHaveCount(2, { timeout: 10_000 });
    } finally { await closeAll(host, bob); }
});

test('reload keeps your seat and your vote', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.vote(host.page, '8');
        await host.page.reload();
        await expect(host.page.locator('#header-room-code')).toHaveText(code);
        await expect(host.page.locator('#header-role-badge')).toHaveText('HOST');
        await expect(host.page.locator('.deck-card.selected')).toHaveText('8');
    } finally { await closeAll(host); }
});

test('QR code is generated on the page, no outside service involved', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const outside = [];
    host.page.on('request', (r) => { if (/qrserver|qrcode/i.test(r.url()) && !r.url().startsWith(H.BASE)) outside.push(r.url()); });
    try {
        await H.createRoom(host.page, 'Hana');
        await host.page.click('#btn-qr-code');
        const img = host.page.locator('#qr-code-modal-overlay img');
        await expect(img).toBeVisible();
        expect(await img.getAttribute('src')).toMatch(/^data:image\//);
        expect(await img.evaluate((i) => i.naturalWidth)).toBeGreaterThan(100);
        await host.page.keyboard.press('Escape');
        await expect(host.page.locator('#qr-code-modal-overlay')).toHaveCount(0);
        expect(outside).toEqual([]);
    } finally { await closeAll(host); }
});

test('the page never needs a login screen: code + name is all it takes, from a phone-sized screen too', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
    const phone = await phoneCtx.newPage();
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.openSite(phone, `?room=${code}`);
        await phone.fill('#input-player-name', 'Pia');
        await phone.click('#btn-join-room');
        await expect(phone.locator('#view-room')).toHaveClass(/active/);
        await phone.locator('.deck-card', { hasText: /^5$/ }).tap();
        await expect(host.page.locator('#players-grid .poker-card-back.voted')).toHaveCount(1);
        // no horizontal scrolling on the phone
        const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(4);
    } finally { await phoneCtx.close(); await closeAll(host); }
});

test('cards that lift on hover / when selected are not cut off by the box above them', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    try {
        await H.createRoom(host.page, 'Hana');
        const list = host.page.locator('#deck-cards-list');
        await H.vote(host.page, '8');                                       // selected card lifts the most
        await host.page.locator('.deck-card', { hasText: /^3$/ }).hover();  // a hovered card lifts too
        await host.page.waitForTimeout(400);                                // let the transition finish

        const listBox = await list.boundingBox();
        const selected = await host.page.locator('.deck-card.selected').boundingBox();
        const hovered = await host.page.locator('.deck-card', { hasText: /^3$/ }).boundingBox();
        // A clipped card would be cut where the strip's scroll box ends: nothing may rise above the strip
        expect(selected.y).toBeGreaterThanOrEqual(listBox.y);
        expect(hovered.y).toBeGreaterThanOrEqual(listBox.y);

        // and what the eye sees: the top edge of the selected card is actually painted (not clipped)
        const clipped = await host.page.evaluate(() => {
            const sel = document.querySelector('.deck-card.selected').getBoundingClientRect();
            const strip = document.getElementById('deck-cards-list').getBoundingClientRect();
            return sel.top < strip.top;
        });
        expect(clipped).toBe(false);
        await host.page.screenshot({ path: 'recordings/deck-hover-fixed.png', clip: { x: 0, y: Math.max(0, listBox.y - 70), width: 1000, height: listBox.height + 90 } });
    } finally { await host.context.close(); }
});
