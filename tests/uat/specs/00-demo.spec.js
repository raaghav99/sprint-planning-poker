// A narrated walk-through of the whole app, recorded on video: four people, four screens.
//   npx playwright test specs/00-demo.spec.js   ->  recordings/sprint-poker-uat-demo.mp4
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

async function tag(page, text) {                       // name tag in the corner of each person's screen
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

test('recorded demo: create, join, vote, reveal, join back from another device, host hand-over, exit', async ({ browser }) => {
    test.setTimeout(420_000);
    const hana = await H.newUser(browser, 'hana', { record: true });
    const bob = await H.newUser(browser, 'bob', { record: true });
    const cara = await H.newUser(browser, 'cara', { record: true });
    const phone = await H.newUser(browser, 'bob-phone', { record: true });
    const people = [hana, bob, cara, phone];
    const say = async (user, text, ms = 2200) => { await H.caption(user.page, text); await H.pause(user.page, ms); };

    try {
        // All four screens open the site at the same moment
        await Promise.all(people.map((u) => H.openSite(u.page)));
        await tag(hana.page, 'Hana - scrum master (laptop)');
        await tag(bob.page, 'Bob (laptop)');
        await tag(cara.page, 'Cara (laptop)');
        await tag(phone.page, "Bob's phone (a different device)");
        await say(phone, "Bob's phone is waiting here for later", 1200);

        // 1. Host creates the room
        await H.caption(hana.page, '1. Hana creates a session. No sign-up, no password.');
        await H.pause(hana.page, 1800);
        await H.paceCreate();
        await hana.page.click('#tab-create');
        await hana.page.fill('#input-host-name', 'Hana');
        await H.pause(hana.page, 900);
        await hana.page.click('#btn-create-room');
        await hana.page.waitForSelector('#view-room.active');
        const code = (await hana.page.textContent('#header-room-code')).trim();
        await say(hana, `Room ${code} is ready. Hana is the HOST. Share the code, the link or the QR code.`, 3200);

        // 2. Players join
        await H.caption(bob.page, '2. Bob opens the shared link and types just his name');
        await H.openSite(bob.page, `?room=${code}`);
        await tag(bob.page, 'Bob (laptop)');
        await H.pause(bob.page, 1200);
        await bob.page.fill('#input-player-name', 'Bob');
        await bob.page.click('#btn-join-room');
        await bob.page.waitForSelector('#view-room.active');
        await H.caption(cara.page, '2. Cara joins the same way');
        await H.openSite(cara.page, `?room=${code}`);
        await tag(cara.page, 'Cara (laptop)');
        await cara.page.fill('#input-player-name', 'Cara');
        await H.pause(cara.page, 800);
        await cara.page.click('#btn-join-room');
        await cara.page.waitForSelector('#view-room.active');
        await say(hana, 'Everyone appears on the table in real time', 2200);

        // 3. Story + hidden voting
        await H.caption(hana.page, '3. Hana sets the story. Only the host can edit it.');
        hana.page.dialogQueue.push('Checkout #42 - pay with card', 'Card + wallet payments');
        await hana.page.click('#btn-edit-story');
        await expect(bob.page.locator('#story-title')).toContainText('Checkout #42');
        await H.pause(hana.page, 1800);
        await H.caption(bob.page, '4. Everyone votes. Votes stay hidden (thumbs-up = voted).');
        await H.vote(bob.page, '5');
        await H.pause(bob.page, 900);
        await H.vote(cara.page, '8');
        await H.pause(cara.page, 900);
        await H.vote(hana.page, '5');
        await say(hana, 'Nobody can see the others\' cards yet, so nobody gets anchored', 2800);

        // 4. Reveal
        await H.caption(hana.page, '5. Hana reveals: average, median, spread - and votes are now locked');
        await hana.page.click('#btn-reveal');
        await expect(bob.page.locator('#badge-round-status')).toContainText('REVEALED');
        await H.pause(hana.page, 3200);
        await H.caption(hana.page, '6. Hana saves the agreed estimate into the session history');
        hana.page.dialogQueue.push('5');
        await hana.page.click('#btn-save-story');
        await expect(bob.page.locator('#history-list')).toContainText('5 Points');
        await H.pause(hana.page, 2600);

        // 5. Bob changes device: laptop closed, phone joins by name
        await H.caption(bob.page, "7. Bob closes his laptop...");
        await H.pause(bob.page, 1500);
        await bob.page.close();
        await H.caption(phone.page, "Bob's phone: he joins with the same name (any capitals). His old seat must be inactive for ~10s...");
        await H.openSite(phone.page, `?room=${code}`);
        await tag(phone.page, "Bob's phone (a different device)");
        await phone.page.fill('#input-player-name', 'bOb');
        await H.pause(phone.page, 11_500);
        await phone.page.click('#btn-join-room');
        await expect(phone.page.locator('#seat-picker')).toContainText('Bob is inactive');
        await say(phone, 'The app recognises the name and offers to join back - no duplicate Bob, no ghost', 3200);
        await phone.page.getByRole('button', { name: /Join back as Bob/ }).click();
        await phone.page.waitForSelector('#view-room.active');
        await say(phone, 'Bob is back as himself in one click', 2200);
        await say(hana, "Hana's table shows one Bob - not two", 2200);

        // 6. Reload / reopen: straight back in
        await H.caption(hana.page, '8. Hana reloads the page (or reopens the browser): straight back in as host');
        await H.pause(hana.page, 1800);
        await hana.page.reload();
        await hana.page.waitForSelector('#view-room.active');
        await tag(hana.page, 'Hana - scrum master (laptop)');
        await say(hana, 'No login, no questions: same room, same seat, still HOST', 2800);

        // 7. Hand over the host role
        await H.caption(hana.page, '9. Hana hands the host role to Cara');
        await H.pause(hana.page, 1500);
        await hana.page.locator('.player-seat', { hasText: 'Cara' }).locator('.make-host-btn').click();
        await expect(cara.page.locator('#header-role-badge')).toHaveText('HOST');
        await say(cara, 'Cara is now the HOST and gets the host controls', 2800);
        await say(hana, 'Hana is a regular player now', 1800);

        // 8. Next round by the new host
        await H.caption(cara.page, '10. Cara runs the next round: story, votes, reveal');
        cara.page.dialogQueue.push('Search filters #43', 'Filter by date and owner');
        await cara.page.click('#btn-edit-story');
        await H.vote(hana.page, '3');
        await H.vote(cara.page, '3');
        await H.vote(phone.page, '3');
        await H.pause(cara.page, 1500);
        await cara.page.click('#btn-reveal');
        await say(cara, 'All three picked 3: the app shows a unanimous result', 3200);

        // 9. Exit leaves no ghost
        await H.caption(phone.page, '11. Bob leaves with Exit...');
        await H.pause(phone.page, 1500);
        await phone.page.click('#btn-exit-room');
        await expect(hana.page.locator('#players-grid .player-seat')).toHaveCount(2, { timeout: 8_000 });
        await say(hana, "...and his seat disappears immediately for everyone: no ghosts", 3200);
        await say(cara, 'Done: easy in, easy back, nobody left hanging', 2600);
    } finally {
        // Close every screen (this finishes the videos) and move them next to each other
        const files = {};
        for (const u of people) files[u.label] = await H.saveVideo(u, `demo-${u.label}.webm`).catch(() => null);

        // One side-by-side movie of the four screens
        const dir = H.RECORDINGS;
        const out = path.join(dir, 'sprint-poker-uat-demo.mp4');
        const order = ['hana', 'cara', 'bob', 'bob-phone'];
        if (order.every((k) => files[k] && fs.existsSync(files[k]))) {
            const inputs = order.flatMap((k) => ['-i', files[k]]);
            const scale = (i) => `[${i}:v]fps=25,scale=640:460:force_original_aspect_ratio=decrease,pad=640:460:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`;
            const filter = `${order.map((_, i) => scale(i)).join(';')};[v0][v1][v2][v3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0:fill=black[v]`;
            execFileSync('ffmpeg', ['-y', ...inputs, '-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', out], { stdio: 'ignore' });
            console.log('Combined recording:', out);
        }
    }
});
