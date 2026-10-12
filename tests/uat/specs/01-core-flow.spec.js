const fs = require('fs');
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test('core scrum round: hidden votes, reveal, stats, vote lock, save, history, CSV export', async ({ browser }) => {
    const host = await H.newUser(browser, 'host');
    const bob = await H.newUser(browser, 'bob');
    const cara = await H.newUser(browser, 'cara');
    try {
        const code = await H.createRoom(host.page, 'Hana');
        await expect(host.page.locator('#header-role-badge')).toHaveText('HOST');
        await H.joinRoom(bob.page, code, 'Bob');
        await H.joinRoom(cara.page, code, 'Cara');
        await expect(host.page.locator('#players-grid .player-seat')).toHaveCount(3);
        await expect(bob.page.locator('#header-role-badge')).toHaveText('VOTER');
        await expect(bob.page.locator('#btn-reveal')).toBeHidden();               // only the host controls the round

        // Story text is shown as text (never interpreted as HTML) and '#' survives
        host.page.dialogQueue.push('Checkout #42 <b>bold</b>', 'Pay with card & wallet');
        await host.page.click('#btn-edit-story');
        await expect(host.page.locator('#story-title')).toHaveText('Checkout #42 <b>bold</b>');
        await expect(bob.page.locator('#story-title')).toHaveText('Checkout #42 <b>bold</b>');
        await expect(cara.page.locator('#story-desc')).toHaveText('Pay with card & wallet');

        await H.vote(bob.page, '5');
        await H.vote(cara.page, '8');
        await H.vote(host.page, '5');
        await expect(host.page.locator('#players-grid .poker-card-back.voted')).toHaveCount(3);

        // Votes stay secret until the host reveals
        expect(await host.page.locator('#players-grid').innerText()).not.toMatch(/\b8\b/);
        await expect(bob.page.locator('#badge-round-status')).toContainText('VOTING');

        await host.page.click('#btn-reveal');
        await expect(bob.page.locator('#badge-round-status')).toContainText('REVEALED');
        await expect(host.page.locator('#stat-average')).toHaveText('6');
        await expect(host.page.locator('#stat-median')).toHaveText('5');
        await expect(host.page.locator('#stat-consensus')).toContainText(/Range \(5\s*[–-]\s*8\)/);
        await expect(cara.page.locator('#players-grid')).toContainText('8');

        // Votes are locked after reveal
        await expect(bob.page.locator('.deck-card').first()).toBeDisabled();

        // Host saves the agreed estimate -> next round starts, history keeps it
        host.page.dialogQueue.push('5');
        await host.page.click('#btn-save-story');
        await expect(bob.page.locator('#badge-round-status')).toContainText('VOTING');
        await expect(host.page.locator('#history-list')).toContainText('Checkout #42 <b>bold</b>');
        await expect(host.page.locator('#history-list')).toContainText('5 Points');
        await expect(cara.page.locator('#history-list')).toContainText('5 Points');

        // CSV: complete (the '#' in the title must not cut the file off)
        const [download] = await Promise.all([host.page.waitForEvent('download'), host.page.click('#btn-export-csv')]);
        const csv = fs.readFileSync(await download.path(), 'utf8');
        expect(csv).toContain('Checkout #42 <b>bold</b>');
        expect(csv).toContain('"5"');
        expect(csv.split(/\r?\n/).length).toBeGreaterThanOrEqual(2);
    } finally {
        await Promise.all([host, bob, cara].map((u) => u.context.close()));
    }
});
