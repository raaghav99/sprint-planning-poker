// Layout at many screen sizes: nothing wider than the screen, nothing cut off, key buttons reachable.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

const WIDTHS = [320, 360, 390, 414, 768, 1024, 1440];
const SHOTS = path.join(H.RECORDINGS, 'responsive');

test('every screen size: no sideways scrolling, controls inside the screen, lifted cards not cut off', async ({ browser }) => {
    test.setTimeout(300_000);
    fs.mkdirSync(SHOTS, { recursive: true });
    const host = await H.newUser(browser, 'host');
    const problems = [];
    try {
        const code = await H.createRoom(host.page, 'Hana');

        for (const width of WIDTHS) {
            const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 780 : 800 }, isMobile: width < 500, hasTouch: width < 500 });
            const page = await ctx.newPage();
            page.on('dialog', (d) => d.accept());
            try {
                // ---- lobby
                await H.openSite(page, `?room=${code}`);
                let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
                if (overflow > 2) problems.push(`${width}px lobby: page is ${overflow}px wider than the screen`);
                await page.screenshot({ path: path.join(SHOTS, `lobby-${width}.png`) });

                // ---- room
                await page.fill('#input-player-name', `P${width}`);
                await page.click('#btn-join-room');
                await page.waitForSelector('#view-room.active');
                await page.locator('.deck-card', { hasText: /^8$/ }).click();                 // selected card lifts the most
                await page.waitForTimeout(500);

                const m = await page.evaluate(() => {
                    const vw = document.documentElement.clientWidth;
                    const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
                    const sel = document.querySelector('.deck-card.selected').getBoundingClientRect();
                    const strip = document.getElementById('deck-cards-list').getBoundingClientRect();
                    return {
                        vw,
                        overflow: document.documentElement.scrollWidth - vw,
                        exit: box('#btn-exit-room'),
                        room: box('#header-room-code'),
                        deckSelect: box('#select-deck'),
                        selectedAboveStrip: sel.top < strip.top - 0.5
                    };
                });
                if (m.overflow > 2) problems.push(`${width}px room: page is ${m.overflow}px wider than the screen`);
                if (!m.exit || m.exit.r > m.vw + 1 || m.exit.l < -1) problems.push(`${width}px: Exit button is off screen`);
                if (!m.room || m.room.r > m.vw + 1) problems.push(`${width}px: room code is off screen`);
                if (m.deckSelect && m.deckSelect.r > m.vw + 1) problems.push(`${width}px: deck picker is off screen`);
                if (m.selectedAboveStrip) problems.push(`${width}px: the selected card is cut off at the top`);
                await page.screenshot({ path: path.join(SHOTS, `room-${width}.png`) });
            } finally { await ctx.close(); }
        }
        console.log(problems.length ? `LAYOUT PROBLEMS:\n - ${problems.join('\n - ')}` : `layout OK at ${WIDTHS.join(', ')} px`);
        expect(problems).toEqual([]);
    } finally { await host.context.close(); }
});
