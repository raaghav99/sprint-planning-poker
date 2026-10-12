// Narrated recording: what happens when the host leaves. Three screens side by side.
//   npx playwright test specs/06-demo-host.spec.js  ->  recordings/sprint-poker-uat-host-demo.mp4
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

async function tag(page, text) {
    await page.evaluate((t) => {
        let el = document.getElementById('__tag');
        if (!el) {
            el = document.createElement('div');
            el.id = '__tag';
            el.style.cssText = 'position:fixed;left:8px;top:28px;z-index:99999;background:#6366f1;color:#fff;'
                + 'font:700 13px system-ui,sans-serif;padding:4px 10px;border-radius:999px;pointer-events:none';
            document.body.appendChild(el);
        }
        el.textContent = t;
    }, text);
}

test('recorded demo: the host leaves - Exit, dropped connection, returning, hand-over', async ({ browser }) => {
    test.setTimeout(420_000);
    const hana = await H.newUser(browser, 'hana', { record: true });
    const bob = await H.newUser(browser, 'bob', { record: true });
    const cara = await H.newUser(browser, 'cara', { record: true });
    const people = [hana, bob, cara];
    const say = async (user, text, ms = 2200) => { await H.caption(user.page, text); await H.pause(user.page, ms); };
    const sayAll = async (text, ms = 2400) => { await Promise.all(people.map((u) => H.caption(u.page, text))); await H.pause(hana.page, ms); };
    const badge = (u) => u.page.locator('#header-role-badge');

    try {
        await Promise.all(people.map((u) => H.openSite(u.page)));
        await tag(hana.page, 'Hana - HOST');
        await tag(bob.page, 'Bob (joined 1st)');
        await tag(cara.page, 'Cara (joined 2nd)');

        // Set the scene: Hana hosts, Bob then Cara join
        await sayAll('Setup: Hana creates a room, then Bob and Cara join (in that order)', 1800);
        await H.paceCreate();
        await hana.page.click('#tab-create');
        await hana.page.fill('#input-host-name', 'Hana');
        await hana.page.click('#btn-create-room');
        await hana.page.waitForSelector('#view-room.active');
        const code = (await hana.page.textContent('#header-room-code')).trim();
        await H.openSite(bob.page, `?room=${code}`);
        await tag(bob.page, 'Bob (joined 1st)');
        await bob.page.fill('#input-player-name', 'Bob');
        await bob.page.click('#btn-join-room');
        await bob.page.waitForSelector('#view-room.active');
        await H.openSite(cara.page, `?room=${code}`);
        await tag(cara.page, 'Cara (joined 2nd)');
        await cara.page.fill('#input-player-name', 'Cara');
        await cara.page.click('#btn-join-room');
        await cara.page.waitForSelector('#view-room.active');
        await sayAll('Only the HOST has Reveal / Clear / Save buttons. Bob and Cara are voters.', 3000);

        // A. Host presses Exit
        await sayAll('A. Hana presses EXIT (she leaves on purpose)', 1800);
        await hana.page.click('#btn-exit-room');
        await expect(bob.page.locator('#btn-reveal')).toBeVisible({ timeout: 8_000 });
        await hana.page.waitForSelector('#view-lobby.active');                // her page reloads to the lobby after Exit
        await tag(hana.page, 'Hana (left)');
        await say(bob, 'Bob joined first, so he becomes the acting host IMMEDIATELY - host buttons appear', 3200);
        await say(cara, 'Cara stays a voter. Everyone is told who is hosting now.', 2600);
        await say(hana, 'Hana is out of the room (her seat is kept for her)', 1800);

        // B. Host returns
        await say(hana, 'B. Hana comes back: just the room code and her name', 1800);
        await hana.page.fill('#input-room-code', code);
        await hana.page.fill('#input-player-name', 'Hana');
        await hana.page.click('#tab-join');
        await hana.page.fill('#input-room-code', code);
        await hana.page.fill('#input-player-name', 'Hana');
        await hana.page.click('#btn-join-room');
        await hana.page.waitForSelector('#view-room.active');
        await tag(hana.page, 'Hana - HOST');
        await expect(badge(bob)).toHaveText('VOTER', { timeout: 10_000 });
        await say(hana, 'Hana is HOST again straight away - no duplicate of her on the table', 3000);
        await say(bob, 'Bob drops back to a normal voter: "The host is back"', 2800);

        // C. Connection drops (not Exit): grace period
        await sayAll('C. Hana\'s connection DROPS (laptop lid closed, wifi gone) - not Exit', 2000);
        await hana.page.evaluate(() => window.pokerApp.network.disconnect());
        await H.caption(hana.page, 'Hana is offline...');
        const started = Date.now();
        while (!(await bob.page.locator('#btn-reveal').isVisible())) {
            const s = Math.round((Date.now() - started) / 1000);
            await H.caption(bob.page, `Host offline for ${s}s - a 30s grace period first, so a quick reload does not hand over`);
            await H.caption(cara.page, `Host offline for ${s}s - still waiting...`);
            await H.pause(cara.page, 2000);
            if (s > 50) break;
        }
        await expect(badge(bob)).toHaveText('HOST');
        await say(bob, 'After ~30s Bob (first to join) becomes acting host', 3000);

        // D. Host returns after a drop
        await say(hana, 'D. Hana\'s connection is back (page reload / reopen)', 1800);
        await hana.page.evaluate(() => window.pokerApp.restoreSession());
        await expect(badge(hana)).toHaveText('HOST', { timeout: 10_000 });
        await expect(badge(bob)).toHaveText('VOTER', { timeout: 10_000 });
        await say(hana, 'Hana regains the host role automatically', 2600);
        await say(bob, 'Bob is a voter again', 2000);

        // E. Permanent hand-over
        await sayAll('E. Hana decides to hand the host role to Cara for good', 1800);
        await hana.page.locator('.player-seat', { hasText: 'Cara' }).locator('.make-host-btn').click();
        await expect(badge(cara)).toHaveText('HOST');
        await say(cara, 'Cara is the HOST now and has the buttons', 2800);
        await say(hana, 'Hana reloads the page...', 1500);
        await hana.page.reload();
        await hana.page.waitForSelector('#view-room.active');
        await tag(hana.page, 'Hana (voter)');
        await expect(badge(hana)).toHaveText('VOTER');
        await say(hana, '...and stays a normal player: the hand-over is permanent', 3000);
        await sayAll('Summary: Exit = instant takeover | connection drop = 30s grace | host returns = gets it back | hand-over = permanent', 4500);
    } finally {
        const files = {};
        for (const u of people) files[u.label] = await H.saveVideo(u, `host-demo-${u.label}.webm`).catch(() => null);
        const out = path.join(H.RECORDINGS, 'sprint-poker-uat-host-demo.mp4');
        const order = ['hana', 'bob', 'cara'];
        if (order.every((k) => files[k] && fs.existsSync(files[k]))) {
            const inputs = order.flatMap((k) => ['-i', files[k]]);
            const scale = (i) => `[${i}:v]fps=25,scale=640:460:force_original_aspect_ratio=decrease,pad=640:460:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`;
            const filter = `${order.map((_, i) => scale(i)).join(';')};[v0][v1][v2]hstack=inputs=3[v]`;
            execFileSync('ffmpeg', ['-y', ...inputs, '-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', out], { stdio: 'ignore' });
            console.log('Host recording:', out);
        }
    }
});
