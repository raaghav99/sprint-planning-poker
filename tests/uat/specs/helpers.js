// Shared helpers for the UAT specs.
const fs = require('fs');
const path = require('path');

const BASE = process.env.UAT_URL || 'https://sprint-poker-worker-uat.temp66081.workers.dev';
const ORIGIN = new URL(BASE).origin;
const RECORDINGS = path.join(__dirname, '..', 'recordings');

// The server allows 10 room creations per minute per IP: keep every create ~7s apart.
let lastCreate = 0;
async function paceCreate(ms = 7000) {
    const wait = lastCreate + ms - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCreate = Date.now();
}

// confirm() = yes; prompt() = next queued answer (page.dialogQueue) or its default value
function attachDialogs(page) {
    page.dialogQueue = [];
    page.on('dialog', (d) => {
        const answer = page.dialogQueue.length ? page.dialogQueue.shift() : undefined;
        d.accept(answer);
    });
}

/**
 * One simulated person with their own browser profile (own localStorage = "their laptop").
 * `record: true` records a video of this person's screen.
 */
async function newUser(browser, label, { record = false, storageState } = {}) {
    fs.mkdirSync(RECORDINGS, { recursive: true });
    const size = { width: 1000, height: 720 };
    const context = await browser.newContext({
        viewport: size,
        storageState,
        recordVideo: record ? { dir: path.join(RECORDINGS, '_raw', label), size } : undefined
    });
    const page = await context.newPage();
    attachDialogs(page);
    return { label, context, page };
}

/** Open a fresh page (tab) in the same browser profile. */
async function newTab(user) {
    const page = await user.context.newPage();
    attachDialogs(page);
    return page;
}

async function openSite(page, query = '') {
    await page.goto(`${BASE}/${query}`);
    // Whichever screen is shown (the room view when the app resumes a saved seat, else the lobby)
    await page.waitForSelector('#view-lobby.active, #view-room.active');
}

async function createRoom(page, name) {
    await paceCreate();
    await openSite(page);
    await page.click('#tab-create');
    await page.fill('#input-host-name', name);
    await page.click('#btn-create-room');
    await page.waitForSelector('#view-room.active');
    const code = (await page.textContent('#header-room-code')).trim();
    return code;
}

async function joinRoom(page, code, name) {
    await openSite(page, `?room=${code}`);
    await page.fill('#input-player-name', name);
    await page.click('#btn-join-room');
    await page.waitForSelector('#view-room.active');
}

async function vote(page, card) {
    await page.locator('.deck-card', { hasText: new RegExp(`^${card}$`) }).click();
}

function seatNames(page) {
    return page.locator('#players-grid .player-name').allTextContents().then((l) => l.map((t) => t.replace(/\s+/g, ' ').trim()));
}

/** Big on-screen caption so a recording explains what is happening. */
async function caption(page, text) {
    await page.evaluate((t) => {
        let el = document.getElementById('__caption');
        if (!el) {
            el = document.createElement('div');
            el.id = '__caption';
            el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:rgba(15,23,42,.92);color:#fff;'
                + 'font:600 16px/1.35 system-ui,sans-serif;padding:10px 16px;text-align:center;pointer-events:none';
            document.body.appendChild(el);
        }
        el.textContent = t;
    }, text);
}

const pause = (page, ms) => page.waitForTimeout(ms);

/** Close a user's context (flushes the video) and move the video to recordings/<name>.webm */
async function saveVideo(user, fileName) {
    const video = user.page.video();
    await user.context.close();
    if (!video) return null;
    const target = path.join(RECORDINGS, fileName);
    fs.mkdirSync(RECORDINGS, { recursive: true });
    await video.saveAs(target);
    return target;
}

module.exports = {
    BASE, ORIGIN, RECORDINGS, paceCreate, newUser, newTab, openSite, createRoom, joinRoom, vote, seatNames, caption, pause, saveVideo
};
