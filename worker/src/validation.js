/**
 * Sprint Planning Poker v2.0 - Request Validation Helpers
 */

export function isValidRoomCode(code) {
    if (!code || typeof code !== 'string') return false;
    const clean = code.trim().toUpperCase();
    return /^[A-Z0-9]{4,8}$/.test(clean);
}

// Client ids look like "p_<base36>"; accept any short url-safe id.
export function isValidPlayerId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(id);
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

// Trim, drop control characters (keeping tab/newline) and truncate. Never rejects, so older clients keep working.
export function sanitizeText(value, maxLen) {
    if (typeof value !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, '').trim().slice(0, maxLen);
}

// Single-line variant for names and titles: whitespace runs collapse to one space.
export function sanitizeLine(value, maxLen) {
    return sanitizeText(value, maxLen * 2).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

export function sanitizeName(value, fallback = 'Guest') {
    return sanitizeLine(value, 30) || fallback;
}

export function randomHex(bytes) {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const buf = new Uint8Array(6);
    crypto.getRandomValues(buf);
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(buf[i] % chars.length);
    }
    return code;
}
