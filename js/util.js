/**
 * Shared helpers
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape any value before interpolating it into innerHTML. */
export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Room codes are 4-8 uppercase letters/digits. */
export function isValidRoomCode(code) {
    return typeof code === 'string' && /^[A-Z0-9]{4,8}$/.test(code);
}
