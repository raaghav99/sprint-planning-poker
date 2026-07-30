/**
 * Sprint Planning Poker v2.0 - WebSocket Connection & Broadcast Helper
 */

export function sendJSON(socket, event, payload = {}) {
    try {
        if (socket && socket.readyState === 1) { // 1 = OPEN
            socket.send(JSON.stringify({ event, payload, timestamp: Date.now() }));
        }
    } catch (err) {
        console.warn('[WS Send Error]:', err);
    }
}

export function broadcastJSON(socketsMap, event, payload = {}, excludePlayerId = null) {
    socketsMap.forEach((socket, playerId) => {
        if (excludePlayerId && playerId === excludePlayerId) return;
        sendJSON(socket, event, payload);
    });
}
