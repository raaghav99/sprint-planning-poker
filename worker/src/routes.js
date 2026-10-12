/**
 * Sprint Planning Poker v2.0 - Worker API Router
 */

import { CORS_HEADERS } from './constants.js';
import { generateRoomCode, isValidRoomCode } from './validation.js';
import { checkOrigin, clientIp, memoryRateLimited, checkCreateLimit } from './guard.js';

const ACTIONS = new Set(['vote', 'reveal', 'reset', 'story', 'deck', 'save_story', 'make_host']);
const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

async function readJson(request) {
    try {
        const body = await request.json();
        return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    } catch (e) {
        return null;
    }
}

function roomStub(env, code) {
    return env.POKER_ROOM.get(env.POKER_ROOM.idFromName(code));
}

// Re-serialize the body so the Durable Object never sees a stale Content-Length.
function forwardJson(env, code, url, body) {
    return roomStub(env, code).fetch(new Request(`${url.origin}${url.pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }));
}

function normalizeCode(value) {
    return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export async function handleApiRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Only the configured site(s) may use this backend from a browser. Room creation additionally
    // REQUIRES an allowed Origin (browsers always send one on cross-origin POSTs).
    const isCreate = path === '/api/room/create' && request.method === 'POST';
    const originProblem = checkOrigin(request, env, { required: isCreate });
    if (originProblem) {
        return json({
            error: originProblem === 'missing'
                ? 'Missing Origin header. Use the Planning Poker web page.'
                : 'This site is not allowed to use this backend.',
            code: 'origin_blocked' // lets the client tell this apart from a seat/token problem
        }, 403);
    }

    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: CORS_HEADERS });
    }

    // Cheap best-effort throttle for all traffic (also slows down room-code probing).
    const ip = clientIp(request);
    if (memoryRateLimited(ip, env)) {
        return new Response(JSON.stringify({ error: 'Too many requests. Please wait a minute and try again.' }), {
            status: 429,
            headers: { ...JSON_HEADERS, 'Retry-After': '60' }
        });
    }

    // WEBSOCKET (/ws)
    if (path === '/ws') {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return json({ error: 'Expected WebSocket upgrade' }, 426);
        }
        const code = normalizeCode(url.searchParams.get('room'));
        if (!isValidRoomCode(code)) {
            return new Response('Invalid room code', { status: 400 });
        }
        return roomStub(env, code).fetch(request);
    }

    // ROOM STATE (GET /api/room/state?room=CODE)
    if (path === '/api/room/state') {
        if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
        const code = normalizeCode(url.searchParams.get('room'));
        if (!isValidRoomCode(code)) return json({ error: 'Invalid room code' }, 400);
        return roomStub(env, code).fetch(request);
    }

    // INACTIVE SEATS (GET /api/room/seats?room=CODE)
    if (path === '/api/room/seats') {
        if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
        const code = normalizeCode(url.searchParams.get('room'));
        if (!isValidRoomCode(code)) return json({ error: 'Invalid room code' }, 400);
        return roomStub(env, code).fetch(request);
    }

    // CLAIM A SEAT (POST /api/room/claim)
    if (path === '/api/room/claim') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        const body = await readJson(request);
        if (!body) return json({ error: 'Invalid JSON body' }, 400);

        const code = normalizeCode(body.room || body.roomCode);
        if (!isValidRoomCode(code)) return json({ error: 'Invalid room code' }, 400);

        return forwardJson(env, code, url, body);
    }

    // LEAVE (POST /api/room/leave)
    if (path === '/api/room/leave') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        const body = await readJson(request);
        if (!body) return json({ error: 'Invalid JSON body' }, 400);

        const code = normalizeCode(body.room || body.roomCode);
        if (!isValidRoomCode(code)) return json({ error: 'Invalid room code' }, 400);

        return forwardJson(env, code, url, body);
    }

    // CREATE ROOM (POST /api/room/create)
    if (path === '/api/room/create') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        const body = await readJson(request);
        if (!body) return json({ error: 'Invalid JSON body' }, 400);

        const code = body.roomCode === undefined || body.roomCode === null
            ? generateRoomCode()
            : normalizeCode(body.roomCode);
        if (!isValidRoomCode(code)) return json({ error: 'Invalid room code' }, 400);

        // Exact per-IP limit on creating rooms (each room is a new Durable Object).
        const limit = await checkCreateLimit(env, ip);
        if (!limit.ok) {
            return new Response(JSON.stringify({
                error: `Too many rooms created from your network. Please wait ${limit.retryAfter || 60} seconds and try again.`
            }), {
                status: 429,
                headers: { ...JSON_HEADERS, 'Retry-After': String(limit.retryAfter || 60) }
            });
        }

        return forwardJson(env, code, url, { ...body, roomCode: code });
    }

    // JOIN ROOM (POST /api/room/join)
    if (path === '/api/room/join') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        const body = await readJson(request);
        if (!body) return json({ error: 'Invalid JSON body' }, 400);

        const code = normalizeCode(body.room || body.roomCode);
        if (!isValidRoomCode(code)) return json({ error: 'Invalid room code' }, 400);

        return forwardJson(env, code, url, body);
    }

    // ACTIONS (POST /api/room/{vote|reveal|reset|story|deck|save_story})
    const match = path.match(/^\/api\/room\/([a-z_]+)$/);
    if (match && ACTIONS.has(match[1])) {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        const body = await readJson(request);
        if (!body) return json({ error: 'Invalid JSON body' }, 400);

        const code = normalizeCode(body.room || body.roomCode);
        if (!isValidRoomCode(code)) return json({ error: 'Invalid room code' }, 400);

        return forwardJson(env, code, url, body);
    }

    return json({ error: 'API route not found' }, 404);
}
