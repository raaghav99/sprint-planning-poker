const { test, expect } = require('@playwright/test');
const H = require('./helpers');

const closeAll = (...users) => Promise.all(users.map((u) => u.context.close().catch(() => {})));

test('host away: next person acts as host, original host gets it back on return', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const bob = await H.newUser(browser, 'bob');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.joinRoom(bob.page, code, 'Bob');
        await expect(bob.page.locator('#btn-reveal')).toBeHidden();

        await host.page.close();                                     // host's laptop dies
        await expect(bob.page.locator('#btn-reveal')).toBeVisible({ timeout: 45_000 });   // after ~30s Bob acts as host
        await expect(bob.page.locator('#header-role-badge')).toHaveText('HOST');
        await expect(bob.page.getByText('acting host')).toBeVisible();

        const back = await H.newTab(host);                           // host returns
        await H.openSite(back);
        await expect(back.locator('#header-role-badge')).toHaveText('HOST');
        await expect(bob.page.locator('#header-role-badge')).toHaveText('VOTER', { timeout: 10_000 });
        await expect(bob.page.getByText('The host is back')).toBeVisible();
        await expect(bob.page.locator('#btn-reveal')).toBeHidden();
    } finally { await closeAll(host, bob); }
});

test('host can hand the host role to someone else, for good', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const bob = await H.newUser(browser, 'bob');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.joinRoom(bob.page, code, 'Bob');
        await expect(bob.page.locator('.make-host-btn')).toHaveCount(0);       // voters never see the button

        await host.page.locator('.player-seat', { hasText: 'Bob' }).locator('.make-host-btn').click();
        await expect(bob.page.locator('#header-role-badge')).toHaveText('HOST');
        await expect(host.page.locator('#header-role-badge')).toHaveText('VOTER');
        await expect(bob.page.getByText('You are now the host')).toBeVisible();
        await expect(host.page.getByText('Bob is now the host')).toBeVisible();

        await host.page.reload();                                    // old host comes back: stays a regular player
        await expect(host.page.locator('#view-room')).toHaveClass(/active/);
        await expect(host.page.locator('#header-role-badge')).toHaveText('VOTER');
        await expect(host.page.locator('#btn-reveal')).toBeHidden();
        await bob.page.locator('#btn-reveal').click();               // the new host really controls the round
        await expect(host.page.locator('#badge-round-status')).toContainText('REVEALED');
    } finally { await closeAll(host, bob); }
});

test('host presses Exit: the next person takes over immediately, and the host gets it back on return', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const bob = await H.newUser(browser, 'bob');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await H.joinRoom(bob.page, code, 'Bob');
        await expect(bob.page.locator('#btn-reveal')).toBeHidden();

        await host.page.click('#btn-exit-room');                              // host leaves on purpose
        // No 30-second wait: an explicit Exit hands over at once
        await expect(bob.page.locator('#btn-reveal')).toBeVisible({ timeout: 6_000 });
        await expect(bob.page.locator('#header-role-badge')).toHaveText('HOST');
        await expect(bob.page.getByText('acting host')).toBeVisible();
        await bob.page.locator('#btn-reveal').click();                        // and Bob can really run the round
        await expect(bob.page.locator('#badge-round-status')).toContainText('REVEALED');

        // Hana comes back with just the code and her name: she is the host again
        await H.joinRoom(host.page, code, 'Hana');
        await expect(host.page.locator('#header-role-badge')).toHaveText('HOST');
        await expect(bob.page.locator('#header-role-badge')).toHaveText('VOTER', { timeout: 10_000 });
        await expect(bob.page.getByText('The host is back')).toBeVisible();
        await expect.poll(async () => (await H.seatNames(bob.page)).filter((n) => n.startsWith('Hana')).length).toBe(1);   // no duplicate Hana
    } finally { await Promise.all([host, bob].map((u) => u.context.close().catch(() => {}))); }
});
