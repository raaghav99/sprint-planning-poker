/**
 * Sprint Planning Poker v2.0 - Cloudflare Worker Main Entry Point
 */

import { PokerRoom } from './Room.js';
import { handleApiRequest } from './routes.js';

export { PokerRoom };

export default {
    async fetch(request, env, ctx) {
        return handleApiRequest(request, env);
    }
};
