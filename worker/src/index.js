/**
 * Sprint Planning Poker v2.0 - Cloudflare Worker Main Entry Point
 */

import { PokerRoom } from './Room.js';
import { RateLimiter } from './RateLimiter.js';
import { handleApiRequest } from './routes.js';
import { CORS_HEADERS } from './constants.js';

export { PokerRoom, RateLimiter };

export default {
    async fetch(request, env, ctx) {
        try {
            return await handleApiRequest(request, env);
        } catch (err) {
            console.error('[Worker Error]:', err);
            return new Response(JSON.stringify({ error: 'Internal error' }), {
                status: 500,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
            });
        }
    }
};
