/**
 * Sprint Planning Poker - API Usage Tracker
 * Tracks daily request count per device to monitor Cloudflare free tier usage.
 * Cloudflare Workers Free: 100,000 requests/day (resets midnight UTC)
 * Per-device soft limit: 2,000 requests/day (safe budget for 20-member team)
 */

const STORAGE_KEY = 'sprint_poker_usage';
const DAILY_BUDGET = 2000; // Per-device soft limit

function _getTodayKey() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function _loadUsage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { date: _getTodayKey(), count: 0 };
        const data = JSON.parse(raw);
        // Reset if it's a new day
        if (data.date !== _getTodayKey()) return { date: _getTodayKey(), count: 0 };
        return data;
    } catch (e) {
        return { date: _getTodayKey(), count: 0 };
    }
}

function _saveUsage(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
}

export function incrementUsage(amount = 1) {
    const data = _loadUsage();
    data.count += amount;
    _saveUsage(data);
    _updateWidget();
}

export function getUsage() {
    const data = _loadUsage();
    return {
        count: data.count,
        budget: DAILY_BUDGET,
        percent: Math.min(100, Math.round((data.count / DAILY_BUDGET) * 100)),
        remaining: Math.max(0, DAILY_BUDGET - data.count)
    };
}

function _getResetInfo() {
    const now = new Date();
    const nextMidnightUTC = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0
    ));
    const msLeft = nextMidnightUTC - now;
    const hrs = Math.floor(msLeft / 3_600_000);
    const mins = Math.floor((msLeft % 3_600_000) / 60_000);
    return `${hrs}h ${mins}m`;
}

function _getStatusColor(percent) {
    if (percent < 50) return '#10b981'; // green
    if (percent < 80) return '#f59e0b'; // amber
    return '#ef4444';                   // red
}

function _updateWidget() {
    const widget = document.getElementById('usage-widget');
    if (!widget) return;

    const { count, budget, percent, remaining } = getUsage();
    const color = _getStatusColor(percent);
    const resetIn = _getResetInfo();

    // Update the arc/ring
    const circle = widget.querySelector('.usage-ring-fill');
    if (circle) {
        const circumference = 2 * Math.PI * 14; // r=14
        const offset = circumference * (1 - percent / 100);
        circle.style.strokeDashoffset = offset;
        circle.style.stroke = color;
    }

    // Update text
    const label = widget.querySelector('.usage-pct-label');
    if (label) label.textContent = `${100 - percent}%`;

    // Update tooltip
    const tip = widget.querySelector('.usage-tooltip');
    if (tip) {
        tip.innerHTML = `
            <div style="font-weight:700; margin-bottom:4px; font-size:0.8rem;">⚡ API Usage Today</div>
            <div style="color:${color}; font-weight:700; font-size:1.1rem; margin-bottom:2px;">${percent}% used</div>
            <div style="color:#94a3b8; font-size:0.75rem; margin-bottom:6px;">${count} / ${budget} requests</div>
            <div style="border-top:1px solid rgba(255,255,255,0.1); padding-top:6px; color:#94a3b8; font-size:0.72rem;">
                🔄 Resets in <strong style="color:#e2e8f0;">${resetIn}</strong>
            </div>
        `;
    }
}

export function initUsageWidget() {
    const widget = document.getElementById('usage-widget');
    if (!widget) return;

    const circumference = 2 * Math.PI * 14;

    widget.innerHTML = `
        <div class="usage-ring-wrap" title="API Usage">
            <svg width="36" height="36" viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="14"
                    fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="3.5"/>
                <circle class="usage-ring-fill" cx="18" cy="18" r="14"
                    fill="none" stroke="#10b981" stroke-width="3.5"
                    stroke-linecap="round"
                    stroke-dasharray="${circumference}"
                    stroke-dashoffset="${circumference}"
                    transform="rotate(-90 18 18)"
                    style="transition: stroke-dashoffset 0.5s ease, stroke 0.4s ease;"/>
            </svg>
            <span class="usage-pct-label">—</span>
        </div>
        <div class="usage-tooltip">Loading...</div>
    `;

    _updateWidget();

    // Refresh the reset countdown every minute
    setInterval(_updateWidget, 60_000);
}
