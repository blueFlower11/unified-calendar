// Unified Calendar server — zero dependencies (Node 18+).
// Pulls ICS feeds from your calendars, keeps them fresh, and serves one merged view.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseICS, expand } = require('./ics');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // feed URLs are private; keep local by default
const DATA_FILE = process.env.CAL_DATA || path.join(__dirname, 'calendars.json');
const REFRESH_MS = (parseInt(process.env.REFRESH_MINUTES, 10) || 15) * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const PALETTE = ['#4f86f7', '#e8710a', '#0f9d58', '#a142f4', '#d93025', '#00897b'];

// ---------- storage ----------
let calendars = [];
const cache = new Map(); // id -> { events, updatedAt, error }

function load() {
  try { calendars = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { calendars = []; }
}
function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(calendars, null, 2), { mode: 0o600 });
}

// ---------- fetching ----------
function fetchText(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url.replace(/^webcal:/i, 'https:'));
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('Only http(s)/webcal links are supported'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers: { 'User-Agent': 'unified-calendar/0.1', Accept: 'text/calendar,*/*' }, timeout: 20000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Too many redirects'));
        return resolve(fetchText(new URL(res.headers.location, u).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > 25e6) { req.destroy(new Error('Feed too large')); } else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}

async function refreshOne(cal) {
  try {
    const text = await fetchText(cal.url);
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link did not return a calendar (.ics) file');
    cache.set(cal.id, { events: parseICS(text), updatedAt: Date.now(), error: null });
  } catch (err) {
    const prev = cache.get(cal.id);
    // keep last good data so a temporary outage doesn't blank the calendar
    cache.set(cal.id, { events: prev ? prev.events : [], updatedAt: prev ? prev.updatedAt : null, error: err.message });
  }
}
const refreshAll = () => Promise.all(calendars.map(refreshOne));

// ---------- http helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}
const publicCal = c => {
  const k = cache.get(c.id) || {};
  return { id: c.id, name: c.name, color: c.color, group: c.group, updatedAt: k.updatedAt || null, error: k.error || null, count: (k.events || []).length };
};

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/api/calendars' && req.method === 'GET') return send(res, 200, calendars.map(publicCal));

  if (p === '/api/calendars' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.url || !/^(https?|webcal):\/\//i.test(b.url)) return send(res, 400, { error: 'Paste the calendar\'s private .ics link (starts with https:// or webcal://)' });
    const cal = {
      id: crypto.randomBytes(5).toString('hex'),
      name: String(b.name || 'Calendar').slice(0, 60),
      group: ['private', 'college', 'work'].includes(b.group) ? b.group : 'private',
      url: b.url.trim(),
      color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : PALETTE[calendars.length % PALETTE.length],
    };
    calendars.push(cal); save();
    await refreshOne(cal);
    return send(res, 201, publicCal(cal));
  }

  const m = /^\/api\/calendars\/([a-f0-9]+)$/.exec(p);
  if (m && req.method === 'DELETE') {
    calendars = calendars.filter(c => c.id !== m[1]); cache.delete(m[1]); save();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/refresh' && req.method === 'POST') { await refreshAll(); return send(res, 200, calendars.map(publicCal)); }

  if (p === '/api/events' && req.method === 'GET') {
    const from = Date.parse(url.searchParams.get('from')), to = Date.parse(url.searchParams.get('to'));
    if (isNaN(from) || isNaN(to) || to - from > 400 * 86400000) return send(res, 400, { error: 'bad range' });
    const out = [];
    for (const c of calendars) {
      const k = cache.get(c.id); if (!k) continue;
      for (const e of expand(k.events, from, to)) out.push({ ...e, calId: c.id, calName: c.name, color: c.color, group: c.group });
    }
    out.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
    return send(res, 200, out);
  }

  // static files
  let file = p === '/' ? '/index.html' : p;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(full)] || 'application/octet-stream');
  });
}

function start() {
  load();
  refreshAll();
  setInterval(refreshAll, REFRESH_MS).unref();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => send(res, 500, { error: err.message }));
  });
  server.listen(PORT, HOST, () => console.log(`Unified Calendar running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (refreshing every ${REFRESH_MS / 60000} min)`));
  return server;
}

if (require.main === module) start();
module.exports = { start };
