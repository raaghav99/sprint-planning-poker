/**
 * Sprint Planning Poker - abuse guards (Origin allow-list + rate limits)
 *
 * Honest limits of what this does:
 *  - The Origin check stops other WEBSITES from using this backend from a visitor's browser.
 *    Scripts/curl can fake or omit the header, so on its own it is not authentication.
 *  - Room creation requires an allowed Origin and is rate limited per IP by an exact counter
 *    (RateLimiter Durable Object). Everything else gets a cheap best-effort in-memory limit.
 */

const DEFAULT_CREATE_LIMIT = 10; // rooms per window per IP
const DEFAULT_CREATE_WINDOW_S = 60;
const DEFAULT_API_LIMIT = 1000; // requests per window per IP per isolate (an office shares one IP)
const API_WINDOW_MS = 60 * 1000;

function parseList(raw) {
    return String(raw || '')
        .split(',')
        .map((s) => s.trim().replace(/\/+$/, '').toLowerCase())
        .filter(Boolean);
}

/**
 * Returns null when the request may proceed, or 'missing' / 'blocked' when it must be refused.
 * No ALLOWED_ORIGINS configured = no restriction (keeps local development simple).
 */
export function checkOrigin(request, env, { required = false } = {}) {
    const allowed = parseList(env && env.ALLOWED_ORIGINS);
    if (allowed.length === 0) return null;

    const origin = (request.headers.get('Origin') || '').trim().replace(/\/+$/, '').toLowerCase();
    if (!origin) return required ? 'missing' : null; // non-browser clients send no Origin
    return allowed.includes(origin) ? null : 'blocked';
}

export function clientIp(request) {
    // Cloudflare sets CF-Connecting-IP itself (clients cannot forge it); the fallback is local dev only.
    const ip = request.headers.get('CF-Connecting-IP')
        || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
        || 'unknown';
    // Treat a whole IPv6 /64 as one client: one machine owns billions of addresses in its /64.
    return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
}

// ---- best-effort in-memory limiter (per isolate) for general API traffic
const buckets = new Map(); // ip -> number[] of timestamps
let lastSweep = 0;

export function memoryRateLimited(ip, env) {
    const limit = Number(env && env.API_LIMIT) || DEFAULT_API_LIMIT;
    const now = Date.now();
    let hits = buckets.get(ip);
    if (!hits) {
        hits = [];
        buckets.set(ip, hits);
    }
    while (hits.length && now - hits[0] > API_WINDOW_MS) hits.shift();

    // Refused requests are NOT recorded: a throttled client that keeps retrying must be able to
    // recover once its earlier requests age out of the window (and the list cannot grow in a flood).
    if (hits.length >= limit) return true;
    hits.push(now);

    // Drop idle entries now and then (at most every 30s) so the map cannot grow without bound
    if (buckets.size > 5000 && now - lastSweep > 30 * 1000) {
        lastSweep = now;
        for (const [key, list] of buckets) {
            if (!list.length || now - list[list.length - 1] > API_WINDOW_MS) buckets.delete(key);
        }
    }
    return false;
}

/**
 * Exact per-IP limit for room creation, backed by one small Durable Object per IP.
 * Returns { ok: true } or { ok: false, retryAfter }. Fails open if the limiter is unavailable.
 */
export async function checkCreateLimit(env, ip) {
    if (!env || !env.RATE_LIMITER) return { ok: true };
    const limit = Number(env.CREATE_LIMIT) || DEFAULT_CREATE_LIMIT;
    const windowS = Number(env.CREATE_WINDOW_S) || DEFAULT_CREATE_WINDOW_S;
    try {
        const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`create:${ip}`));
        const res = await stub.fetch(`https://limiter/check?limit=${limit}&window=${windowS}`);
        return await res.json();
    } catch (err) {
        console.warn('[RateLimiter Error]:', err);
        return { ok: true };
    }
}
