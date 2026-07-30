/**
 * Sprint Planning Poker v2.0 - Request Validation Helpers
 */

export function isValidRoomCode(code) {
    if (!code || typeof code !== 'string') return false;
    const clean = code.trim().toUpperCase();
    return /^[A-Z0-9]{4,8}$/.test(clean);
}

export function isValidPlayerName(name) {
    if (!name || typeof name !== 'string') return false;
    const clean = name.trim();
    return clean.length >= 1 && clean.length <= 30;
}

export function isValidStoryTitle(title) {
    if (!title || typeof title !== 'string') return false;
    const clean = title.trim();
    return clean.length >= 1 && clean.length <= 120;
}

export function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}
