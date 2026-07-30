/**
 * Sprint Planning Poker v2.0 - Worker API Router
 */

import { CORS_HEADERS } from './constants.js';
import { generateRoomCode, isValidRoomCode } from './validation.js';

export async function handleApiRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: CORS_HEADERS });
    }

    // CREATE ROOM (/api/room/create)
    if (path === '/api/room/create') {
        const body = await request.json();
        const code = (body.roomCode || generateRoomCode()).toUpperCase();
        const id = env.POKER_ROOM.idFromName(code);
        const roomStub = env.POKER_ROOM.get(id);

        const forwardReq = new Request(`${url.origin}/api/room/create`, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify({ ...body, roomCode: code })
        });

        return roomStub.fetch(forwardReq);
    }

    // JOIN ROOM (/api/room/join)
    if (path === '/api/room/join') {
        const body = await request.json();
        const code = (body.room || body.roomCode || '').toUpperCase();

        if (!isValidRoomCode(code)) {
            return new Response(JSON.stringify({ error: 'Invalid room code' }), {
                status: 400,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
            });
        }

        const id = env.POKER_ROOM.idFromName(code);
        const roomStub = env.POKER_ROOM.get(id);

        const forwardReq = new Request(`${url.origin}/api/room/join`, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(body)
        });

        return roomStub.fetch(forwardReq);
    }

    // ROOM STATE (/api/room/state)
    if (path === '/api/room/state') {
        const code = (url.searchParams.get('room') || '').toUpperCase();
        if (!isValidRoomCode(code)) {
            return new Response(JSON.stringify({ error: 'Invalid room code' }), {
                status: 400,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
            });
        }

        const id = env.POKER_ROOM.idFromName(code);
        const roomStub = env.POKER_ROOM.get(id);
        return roomStub.fetch(request);
    }

    // WEBSOCKET (/ws)
    if (path === '/ws' || request.headers.get('Upgrade') === 'websocket') {
        const code = (url.searchParams.get('room') || '').toUpperCase();
        if (!isValidRoomCode(code)) {
            return new Response('Invalid room code', { status: 400 });
        }

        const id = env.POKER_ROOM.idFromName(code);
        const roomStub = env.POKER_ROOM.get(id);
        return roomStub.fetch(request);
    }

    // ROUTE OTHER ACTION ENDPOINTS (/api/room/vote, /api/room/reveal, /api/room/reset, /api/room/story)
    if (path.startsWith('/api/room/')) {
        const body = await request.clone().json().catch(() => ({}));
        const code = (body.room || body.roomCode || url.searchParams.get('room') || '').toUpperCase();

        if (isValidRoomCode(code)) {
            const id = env.POKER_ROOM.idFromName(code);
            const roomStub = env.POKER_ROOM.get(id);
            return roomStub.fetch(request);
        }
    }

    return new Response(JSON.stringify({ error: 'API route not found' }), {
        status: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
}
