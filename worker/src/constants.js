/**
 * Sprint Planning Poker v2.0 - Backend Constants
 */

export const ROOM_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours room expiration
export const MAX_PLAYERS = 50; // Support up to 50 players per room
export const PING_INTERVAL_MS = 30000; // 30 second WebSocket heartbeat

export const DECKS = {
    fibonacci: ['0', '0.5', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89', '☕', '❓'],
    mod_fibonacci: ['0', '0.5', '1', '2', '3', '5', '8', '13', '20', '40', '100', '☕', '❓'],
    tshirt: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '☕', '❓'],
    powers2: ['0', '1', '2', '4', '8', '16', '32', '64', '☕', '❓']
};

export const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
