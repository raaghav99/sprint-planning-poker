// "Easy to log in, easy to come back, no ghosts, no lockouts."
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

const closeAll = (...users) => Promise.all(users.map((u) => u.context.close().catch(() => {})));

test('same browser: close the tab, come back later, you are straight back in your seat', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const bob = await H.newUser(browser, 'bob');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.joinRoom(bob.page, code, 'Bob');
        await expect(bob.page.locator('#players-grid .player-seat')).toHaveCount(2);

        await host.page.close();                                   // host closes the tab...
        const back = await H.newTab(host);                          // ...and opens the app again
        await H.openSite(back);
        await expect(back.locator('#view-room')).toHaveClass(/active/);
        await expect(back.locator('#header-room-code')).toHaveText(code);
        await expect(back.locator('#header-role-badge')).toHaveText('HOST');   // still the host
        await expect(back.locator('#seat-picker')).toBeHidden();                // no questions asked
        await expect(back.locator('#players-grid .player-seat')).toHaveCount(2);
        // Bob sees exactly one Hana: no duplicate / ghost
        await expect.poll(async () => (await H.seatNames(bob.page)).filter((n) => n.startsWith('Hana')).length).toBe(1);
    } finally { await closeAll(host, bob); }
});

test('browser restart: saved data survives, the session does not - still straight back in', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    let again;
    try {
        const code = await H.createRoom(host.page, 'Hana');
        const saved = await host.context.storageState();           // what the browser keeps on disk
        await host.context.close();                                  // browser fully closed
        again = await H.newUser(browser, 'host-restarted', { storageState: saved });
        await H.openSite(again.page);
        await expect(again.page.locator('#view-room')).toHaveClass(/active/);
        await expect(again.page.locator('#header-room-code')).toHaveText(code);
        await expect(again.page.locator('#header-role-badge')).toHaveText('HOST');
    } finally { await closeAll(host, again || host); }
});

test('another device: same name (any case) -> "Join back" -> one click, vote kept, no duplicate', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const bobLaptop = await H.newUser(browser, 'bob-laptop');
    const bobPhone = await H.newUser(browser, 'bob-phone');       // a different browser = a different device
    const nosy = await H.newUser(browser, 'nosy');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.joinRoom(bobLaptop.page, code, 'Bob');
        await H.vote(bobLaptop.page, '5');

        // Bob's name is online right now: nobody else may take it
        await H.openSite(nosy.page, `?room=${code}`);
        await nosy.page.fill('#input-player-name', 'BOB');
        await nosy.page.click('#btn-join-room');
        await expect(nosy.page.getByText('That name is already in use')).toBeVisible();
        await expect(nosy.page.locator('#view-lobby')).toHaveClass(/active/);

        // Bob closes his laptop. After ~10s his seat counts as inactive.
        await bobLaptop.page.close();
        await host.page.waitForTimeout(11_000);

        await H.openSite(bobPhone.page, `?room=${code}`);
        await bobPhone.page.fill('#input-player-name', 'bOb');
        await bobPhone.page.click('#btn-join-room');
        await expect(bobPhone.page.locator('#seat-picker')).toContainText('Bob is inactive');
        await bobPhone.page.getByRole('button', { name: /Join back as Bob/ }).click();
        await expect(bobPhone.page.locator('#view-room')).toHaveClass(/active/);
        await expect(bobPhone.page.locator('.deck-card.selected')).toHaveText('5');   // vote kept
        await expect.poll(async () => (await H.seatNames(host.page)).filter((n) => n.startsWith('Bob')).length).toBe(1);
        await expect(host.page.locator('#players-grid .player-seat')).toHaveCount(2);
    } finally { await closeAll(host, bobLaptop, bobPhone, nosy); }
});

test('Exit leaves no ghost, and the same browser can join other rooms (no "already in a room" lockout)', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const host2 = await H.newUser(browser, 'host2');
    const bob = await H.newUser(browser, 'bob');
    try {
        const roomA = await H.createRoom(host.page, 'Hana');
        const roomB = await H.createRoom(host2.page, 'Ivan');

        await H.joinRoom(bob.page, roomA, 'Bob');
        await expect(host.page.locator('#players-grid .player-seat')).toHaveCount(2);

        await bob.page.click('#btn-exit-room');                    // confirm() is auto-accepted
        await expect(host.page.locator('#players-grid .player-seat')).toHaveCount(1, { timeout: 8_000 });   // gone at once

        // Same browser, different room: works straight away
        await H.joinRoom(bob.page, roomB, 'Bob');
        await expect(bob.page.locator('#header-room-code')).toHaveText(roomB);
        await expect(host2.page.locator('#players-grid .player-seat')).toHaveCount(2);

        // ...and a second tab of the same browser can sit in the first room at the same time
        const tab2 = await H.newTab(bob);
        await H.joinRoom(tab2, roomA, 'Bob');
        await expect(tab2.locator('#header-room-code')).toHaveText(roomA);
        await expect(bob.page.locator('#header-room-code')).toHaveText(roomB);     // first tab unaffected
        await expect(host.page.locator('#players-grid .player-seat')).toHaveCount(2);
    } finally { await closeAll(host, host2, bob); }
});

test('one place at a time: opening the room in a second tab moves the seat and tells the old tab', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        const oldTab = host.page;
        const newer = await H.newTab(host);
        await H.openSite(newer);                                     // auto-resumes the same room
        await expect(newer.locator('#header-room-code')).toHaveText(code);
        await expect(oldTab.locator('#view-lobby')).toHaveClass(/active/, { timeout: 10_000 });
        await expect(oldTab.getByText('opened this room somewhere else')).toBeVisible();
        await expect(newer.locator('#header-role-badge')).toHaveText('HOST');
    } finally { await closeAll(host); }
});
