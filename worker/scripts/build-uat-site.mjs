/**
 * Builds the UAT frontend: a copy of the site whose API address is the UAT worker itself
 * (same origin, so the page and the API come from one place) with a visible UAT badge.
 * Output goes to .uat-site/, which `wrangler deploy --env uat` serves as static assets.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(dirname(fileURLToPath(import.meta.url)), '..', '.uat-site');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const item of ['css', 'js']) cpSync(join(root, item), join(out, item), { recursive: true });

let html = readFileSync(join(root, 'index.html'), 'utf8');
const before = html;
html = html.replace(/window\.WORKER_URL\s*=\s*"[^"]*";/, 'window.WORKER_URL = window.location.origin;');
if (html === before) throw new Error('Could not find the WORKER_URL line in index.html');

const badge = '<div id="uat-badge" style="position:fixed;top:0;left:50%;transform:translateX(-50%);background:#f59e0b;'
    + 'color:#111;font:700 11px/1 system-ui,sans-serif;padding:3px 12px;border-radius:0 0 8px 8px;z-index:2000;'
    + 'letter-spacing:1px;pointer-events:none">UAT</div>';
html = html.replace('</body>', `${badge}\n</body>`);
html = html.replace(/<title>([^<]*)<\/title>/, '<title>[UAT] $1</title>');

writeFileSync(join(out, 'index.html'), html);
console.log('UAT site built in', out);
