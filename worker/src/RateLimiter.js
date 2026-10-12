/**
 * Sprint Planning Poker - RateLimiter Durable Object
 * One instance per key (e.g. "create:<ip>"): a sliding window of recent hits.
 * Hits are persisted, so the count survives the object being evicted from memory, and an alarm
 * clears the storage once the window has passed.
 */

export class RateLimiter {
    constructor(state, env) {
        this.state = state;
        this.hits = [];
        this.state.blockConcurrencyWhile(async () => {
            this.hits = (await this.state.storage.get('hits')) || [];
        });
    }

    async fetch(request) {
        const url = new URL(request.url);
        const limit = Math.max(1, Number(url.searchParams.get('limit')) || 10);
        const windowMs = Math.max(1000, (Number(url.searchParams.get('window')) || 60) * 1000);
        const now = Date.now();

        this.hits = this.hits.filter((t) => now - t < windowMs);

        if (this.hits.length >= limit) {
            const retryAfter = Math.max(1, Math.ceil((windowMs - (now - this.hits[0])) / 1000));
            return Response.json({ ok: false, retryAfter });
        }

        this.hits.push(now);
        await this.state.storage.put('hits', this.hits);
        await this.state.storage.setAlarm(now + windowMs + 1000);
        return Response.json({ ok: true });
    }

    // Nothing left to remember once the window has passed
    async alarm() {
        this.hits = [];
        await this.state.storage.deleteAll();
    }
}
