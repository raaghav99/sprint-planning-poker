// UX details and edge cases: bad input, errors, statistics, history, CSV, keyboard, offline, share link.
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

const closeAll = (...users) => Promise.all(users.map((u) => u.context.close().catch(() => {})));

test('joining a room that does not exist shows a clear error and the button works again (no frozen "Connecting...")', async ({ browser }) => {
    const u = await H.newUser(browser, 'visitor');
    try {
        await H.openSite(u.page);
        await u.page.fill('#input-room-code', 'NOPE77');
        await u.page.fill('#input-player-name', 'Zed');
        await u.page.click('#btn-join-room');
        await expect(u.page.getByText('Room does not exist')).toBeVisible();
        await expect(u.page.locator('#view-lobby')).toHaveClass(/active/);
        await expect(u.page.locator('#btn-join-room')).toBeEnabled();
        await expect(u.page.locator('#btn-join-room')).toContainText('Join Session');
    } finally { await closeAll(u); }
});

test('form validation: short code and empty name are refused with a hint; lowercase codes work', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const u = await H.newUser(browser, 'visitor');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.openSite(u.page);

        await u.page.fill('#input-room-code', 'AB');
        await u.page.fill('#input-player-name', 'Zed');
        await u.page.click('#btn-join-room');
        await expect(u.page.getByText('valid Room Code')).toBeVisible();

        await u.page.fill('#input-room-code', code);
        await u.page.fill('#input-player-name', '   ');
        await u.page.click('#btn-join-room');
        await expect(u.page.getByText('Please enter your Display Name')).toBeVisible();
        await expect(u.page.locator('#view-lobby')).toHaveClass(/active/);

        await u.page.fill('#input-room-code', code.toLowerCase());          // typed in lower case
        await u.page.fill('#input-player-name', 'Zed');
        await u.page.click('#btn-join-room');
        await expect(u.page.locator('#view-room')).toHaveClass(/active/);
        await expect(u.page.locator('#header-room-code')).toHaveText(code);
    } finally { await closeAll(host, u); }
});

test('a booby-trapped ?room= link is ignored (nothing is injected or executed)', async ({ browser }) => {
    const u = await H.newUser(browser, 'visitor');
    try {
        await H.openSite(u.page, '?room=%3Cimg%20src%3Dx%20onerror%3Dwindow.__q%3D1%3E');
        expect(await u.page.evaluate(() => window.__q)).toBeUndefined();
        expect(await u.page.locator('#view-lobby img').count()).toBe(0);
        await expect(u.page.locator('#input-room-code')).toHaveValue('');       // not accepted as a room code
        await expect(u.page.locator('#view-lobby')).toHaveClass(/active/);
    } finally { await closeAll(u); }
});

test('names: emoji and accents work, spacing is tidied', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const u = await H.newUser(browser, 'visitor');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.joinRoom(u.page, code, '   Zoë 🎉   ');
        await expect.poll(async () => (await H.seatNames(host.page)).join('|')).toContain('Zoë 🎉');
        expect((await H.seatNames(host.page)).some((n) => n.startsWith(' '))).toBe(false);
    } finally { await closeAll(host, u); }
});

test('deck change: T-shirt sizes, votes are cleared and everyone gets the new cards', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const bob = await H.newUser(browser, 'bob');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.joinRoom(bob.page, code, 'Bob');
        await H.vote(bob.page, '5');
        await expect(host.page.locator('#players-grid .poker-card-back.voted')).toHaveCount(1);

        await expect(bob.page.locator('#select-deck')).toBeDisabled();             // only the host picks the deck
        await host.page.selectOption('#select-deck', 'tshirt');
        await expect(bob.page.locator('.deck-card').first()).toHaveText('XS');
        await expect(bob.page.locator('.deck-card.selected')).toHaveCount(0);       // old vote is gone
        await expect(host.page.locator('#players-grid .poker-card-back.voted')).toHaveCount(0);
        await H.vote(bob.page, 'M');
        await expect(host.page.locator('#players-grid .poker-card-back.voted')).toHaveCount(1);
        await host.page.click('#btn-reveal');
        await expect(host.page.locator('#players-grid')).toContainText('M');
        await expect(host.page.locator('#stat-consensus')).toContainText('No numeric votes');
    } finally { await closeAll(host, bob); }
});

test('deck change AFTER reveal: the round is votable again (not stuck locked)', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const bob = await H.newUser(browser, 'bob');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.joinRoom(bob.page, code, 'Bob');
        await H.vote(bob.page, '5');
        await host.page.click('#btn-reveal');
        await expect(host.page.locator('#players-grid')).toContainText('5');

        await host.page.selectOption('#select-deck', 'tshirt');
        await expect(bob.page.locator('.deck-card').first()).toHaveText('XS');
        await expect(bob.page.locator('.deck-card.selected')).toHaveCount(0);       // old vote is gone
        await H.vote(bob.page, 'M');                                                 // used to be refused: round stayed revealed
        await expect(host.page.locator('#players-grid .poker-card-back.voted')).toHaveCount(1);
        await expect(host.page.locator('#btn-reveal')).toBeVisible();                // back in the voting phase
        await host.page.click('#btn-reveal');
        await expect(host.page.locator('#players-grid')).toContainText('M');
    } finally { await closeAll(host, bob); }
});

test('voting details: clicking your card again clears the vote; Clear / Re-vote resets everyone', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const bob = await H.newUser(browser, 'bob');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.joinRoom(bob.page, code, 'Bob');

        await H.vote(bob.page, '8');
        await expect(host.page.locator('#players-grid .poker-card-back.voted')).toHaveCount(1);
        await H.vote(bob.page, '8');                                                // same card = take it back
        await expect(bob.page.locator('.deck-card.selected')).toHaveCount(0);
        await expect(host.page.locator('#players-grid .poker-card-back.voted')).toHaveCount(0);

        await H.vote(bob.page, '3');
        await H.vote(host.page, '5');
        await host.page.click('#btn-reveal');
        await expect(bob.page.locator('#badge-round-status')).toContainText('REVEALED');
        await host.page.click('#btn-reset');                                         // "Clear / Re-vote"
        await expect(bob.page.locator('#badge-round-status')).toContainText('VOTING');
        await expect(bob.page.locator('.deck-card.selected')).toHaveCount(0);
        await expect(host.page.locator('.deck-card.selected')).toHaveCount(0);
        await expect(host.page.locator('#players-grid .poker-card-back.voted')).toHaveCount(0);
        await expect(bob.page.locator('.deck-card').first()).toBeEnabled();         // voting is open again
    } finally { await closeAll(host, bob); }
});

test('late joiners: mid-round they see only thumbs-up; after reveal they see the real votes', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const bob = await H.newUser(browser, 'bob');
    const cara = await H.newUser(browser, 'cara');
    const dana = await H.newUser(browser, 'dana');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.joinRoom(bob.page, code, 'Bob');
        await H.vote(bob.page, '13');
        await H.vote(host.page, '2');

        await H.joinRoom(cara.page, code, 'Cara');                                    // arrives mid-round
        await expect(cara.page.locator('#players-grid .poker-card-back.voted')).toHaveCount(2);
        expect(await cara.page.locator('#players-grid').innerText()).not.toMatch(/\b13\b/);

        await host.page.click('#btn-reveal');
        await H.joinRoom(dana.page, code, 'Dana');                                    // arrives after the reveal
        await expect(dana.page.locator('#badge-round-status')).toContainText('REVEALED');
        await expect(dana.page.locator('#players-grid')).toContainText('13');
        await expect(dana.page.locator('.deck-card').first()).toBeDisabled();
    } finally { await closeAll(host, bob, cara, dana); }
});

test('statistics: unanimous result, even-count median, and coffee/question-mark cards', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const bob = await H.newUser(browser, 'bob');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.joinRoom(bob.page, code, 'Bob');

        await H.vote(host.page, '5'); await H.vote(bob.page, '5');
        await host.page.click('#btn-reveal');
        await expect(host.page.locator('#stat-consensus')).toContainText('Unanimous (5 pts)');
        await host.page.click('#btn-reset');

        await H.vote(host.page, '3'); await H.vote(bob.page, '5');                       // even count: median is the middle pair
        await host.page.click('#btn-reveal');
        await expect(host.page.locator('#stat-average')).toHaveText('4');
        await expect(host.page.locator('#stat-median')).toHaveText('4');
        await host.page.click('#btn-reset');

        await H.vote(host.page, '☕'); await H.vote(bob.page, '❓');                      // nobody has a number
        await host.page.click('#btn-reveal');
        await expect(host.page.locator('#stat-consensus')).toContainText('No numeric votes');
        await expect(host.page.locator('#stat-average')).toHaveText('—');
    } finally { await closeAll(host, bob); }
});

test('history and CSV: several stories, quotes are doubled, spreadsheet formulas are defused', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    try {
        await H.createRoom(host.page, 'Hana');
        const stories = [['Login #1', '3'], ['He said "hi"', '5'], ['=SUM(1+1)', '8']];
        for (const [title, points] of stories) {
            host.page.dialogQueue.push(title, '');
            await host.page.click('#btn-edit-story');
            await expect(host.page.locator('#story-title')).toHaveText(title);
            await H.vote(host.page, points);
            await host.page.click('#btn-reveal');
            host.page.dialogQueue.push(points);
            await host.page.click('#btn-save-story');
            await expect(host.page.locator('#history-list .history-item')).toHaveCount(stories.findIndex((s) => s[0] === title) + 1);
        }
        const [download] = await Promise.all([host.page.waitForEvent('download'), host.page.click('#btn-export-csv')]);
        const csv = fs.readFileSync(await download.path(), 'utf8');
        const rows = csv.split(/\r?\n/).filter(Boolean);
        expect(rows.length).toBe(1 + stories.length);                                    // header + one row each
        expect(csv).toContain('"Login #1"');                                              // '#' did not cut the file
        expect(csv).toContain('"He said ""hi"""');                                        // quotes doubled
        expect(csv).toContain(`"'=SUM(1+1)"`);                                            // formula neutralised
        expect(csv.startsWith('﻿')).toBe(true);                                      // opens correctly in Excel
    } finally { await closeAll(host); }
});

test('no connection while creating: friendly message, nothing frozen, works once back online', async ({ browser }) => {
    const u = await H.newUser(browser, 'visitor');
    try {
        await H.openSite(u.page);
        await u.page.click('#tab-create');
        await u.page.fill('#input-host-name', 'Hana');
        await u.context.setOffline(true);
        await u.page.click('#btn-create-room');
        await expect(u.page.getByText('Cannot reach the server')).toBeVisible();
        await expect(u.page.locator('#view-lobby')).toHaveClass(/active/);
        await expect(u.page.locator('#btn-create-room')).toBeEnabled();
        await u.context.setOffline(false);
        await H.paceCreate();
        await u.page.click('#btn-create-room');
        await expect(u.page.locator('#view-room')).toHaveClass(/active/, { timeout: 20_000 });
    } finally { await closeAll(u); }
});

test('a saved room that no longer exists never leaves the lobby frozen', async ({ browser }) => {
    const u = await H.newUser(browser, 'visitor');
    try {
        await H.openSite(u.page);
        await u.page.evaluate(() => localStorage.setItem('sprint_poker_last_room',
            JSON.stringify({ roomCode: 'GONE99', displayName: 'Zed', at: Date.now() })));
        await u.page.reload();
        await expect(u.page.getByText('Could not rejoin your previous session')).toBeVisible();
        await expect(u.page.locator('#view-lobby')).toHaveClass(/active/);
        await expect(u.page.locator('#btn-join-room')).toBeEnabled();
        await expect(u.page.locator('#btn-create-room')).toBeEnabled();
        expect(await u.page.evaluate(() => localStorage.getItem('sprint_poker_last_room'))).toBeNull();   // cleaned up
    } finally { await closeAll(u); }
});

test('keyboard: Tab to a card and press Enter votes, and focus stays on that card', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    try {
        await H.createRoom(host.page, 'Hana');
        const card = host.page.locator('.deck-card', { hasText: /^3$/ });
        await card.focus();
        await host.page.keyboard.press('Enter');
        await expect(host.page.locator('.deck-card.selected')).toHaveText('3');
        expect(await host.page.evaluate(() => document.activeElement && document.activeElement.textContent)).toBe('3');
        await host.page.keyboard.press('Tab');
        await host.page.keyboard.press('Enter');                                           // next card (5)
        await expect(host.page.locator('.deck-card.selected')).toHaveText('5');
    } finally { await closeAll(host); }
});

test('share link keeps the page path (also under /sprint-planning-poker/) and opens straight into the join form', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const guestCtx = await browser.newContext();
    try {
        await host.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: H.ORIGIN });
        const code = await H.createRoom(host.page, 'Hana');
        await host.page.click('#btn-share-link');
        await expect(host.page.getByText('Share link copied')).toBeVisible();
        const link = await host.page.evaluate(() => navigator.clipboard.readText());
        const expected = await host.page.evaluate((c) => `${location.origin}${location.pathname}?room=${c}`, code);
        expect(link).toBe(expected);
        expect(link.startsWith(H.BASE)).toBe(true);                                         // same site + path as the page

        const guest = await guestCtx.newPage();
        await guest.goto(link);
        await expect(guest.locator('#input-room-code')).toHaveValue(code);
        await expect(guest.locator('#view-lobby')).toHaveClass(/active/);
    } finally { await closeAll(host); await guestCtx.close(); }
});
