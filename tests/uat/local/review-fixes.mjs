// Regression tests for CODE_REVIEW.md #1, #3, #4. Needs a short ghost window, so run against a local worker:
//   cd worker && npx wrangler dev --port 8799 --var GHOST_MS:2000 SEAT_INACTIVE_MS:500
//   API=http://127.0.0.1:8799 node tests/uat/local/review-fixes.mjs
const API = process.env.API || 'http://127.0.0.1:8799';
const ORIGIN = process.env.ORIGIN || 'https://raaghav99.github.io';
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (path, data) => {
    const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(data) });
    let body = {}; try { body = await r.json(); } catch (e) { /* empty */ }
    return { status: r.status, body };
};
const T = Date.now();
const code = 'R' + Math.random().toString(36).slice(2, 6).toUpperCase();
const host = { id: `p_rv_host${T}` }, bob = { id: `p_rv_bob${T}` }, carol = { id: `p_rv_carol${T}` }, dan = { id: `p_rv_dan${T}` };

let r = await post('/api/room/create', { roomCode: code, playerId: host.id, displayName: 'Hana', authVersion: 1 });
host.token = r.body.token;
r = await post('/api/room/join', { room: code, playerId: bob.id, displayName: 'Bob', authVersion: 1 });
bob.token = r.body.token;
ok(!!bob.token, 'Bob joined with a token');

// #4: deck change after reveal makes the round votable again
r = await post('/api/room/vote', { room: code, playerId: bob.id, token: bob.token, vote: '5' });
await post('/api/room/reveal', { room: code, playerId: host.id, token: host.token });
r = await post('/api/room/vote', { room: code, playerId: bob.id, token: bob.token, vote: '3' });
ok(r.status === 409, '#4 votes are locked after reveal');
r = await post('/api/room/deck', { room: code, playerId: host.id, token: host.token, deckType: 'tshirt' });
ok(r.status === 200 && r.body.state?.roundStatus !== 'REVEALED', '#4 deck change returns the round to voting');
r = await post('/api/room/vote', { room: code, playerId: bob.id, token: bob.token, vote: 'M' });
ok(r.status === 200, '#4 voting works again after the deck change');

// let Bob's seat be pruned (he has no socket), then someone else takes the name "Bob"
await sleep(5000);
r = await post('/api/room/join', { room: code, playerId: carol.id, displayName: 'Bob', authVersion: 1 });
ok(r.status === 200 && r.body.state.players.some((p) => p.id === carol.id && p.displayName === 'Bob'), 'Carol took the free name Bob after the old seat was pruned');

// #1: Bob returns with his token: gets a variant name, and later rejoins with that name keep working
r = await post('/api/room/join', { room: code, playerId: bob.id, displayName: 'Bob', authVersion: 1, token: bob.token });
const mine = r.body.state?.players.find((p) => p.id === bob.id);
ok(r.status === 200 && mine && mine.displayName === 'Bob 2', `#1 returning owner gets a variant name (got ${mine && mine.displayName})`);
r = await post('/api/room/join', { room: code, playerId: bob.id, displayName: mine.displayName, authVersion: 1, token: bob.token });
ok(r.status === 200, '#1 rejoin with the stored variant name succeeds');
r = await post('/api/room/join', { room: code, playerId: bob.id, displayName: 'Bob', authVersion: 1, token: bob.token });
ok(r.status === 409 && r.body.code === 'name_in_use', '#1 server still reports name_in_use for the old typed name (client must not treat it as a lost seat)');

// #3: a failed claim must not burn the caller's reserved token
await sleep(5000);                                                       // Bob (offline again) gets pruned once more
r = await post('/api/room/claim', { room: code, playerId: bob.id, token: bob.token, seatRef: '0123456789abcdef', authVersion: 1 });
ok(r.status === 404, '#3 claim of an unknown seat fails with 404');
r = await post('/api/room/join', { room: code, playerId: bob.id, displayName: 'Bobby', authVersion: 1, token: bob.token });
ok(r.status === 200, '#3 the reservation survived: Bob can still rejoin with his token');
r = await post('/api/room/join', { room: code, playerId: dan.id, displayName: 'Dan', authVersion: 1 });
ok(r.status === 200, 'control: unrelated player joins fine');

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
