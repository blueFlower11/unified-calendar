// Unified Calendar server v0.2 — multi-user, zero npm dependencies (Node 22+).
// Users sign in with Google or Microsoft; their calendars (Google, Outlook, plus any .ics link)
// are merged into one view for the web app and the Android app.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseICS, expand } = require('./ics');
const sec = require('./lib/security');
const { open } = require('./lib/db');
const { makeProviders } = require('./lib/providers');

const PALETTE = ['#4f86f7', '#e8710a', '#0f9d58', '#a142f4', '#d93025', '#00897b', '#c2185b', '#5d4037'];
const SESSION_MS = 30 * 86400000;
const WINDOW_BACK = 60 * 86400000, WINDOW_FWD = 400 * 86400000;
const MAX_ICS_PER_USER = 20;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

let VERSION = 'unknown';
try { VERSION = require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || VERSION; } catch {}

function create(opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  const PORT = opts.port ?? (env.PORT || 3000);
  const HOST = opts.host || env.HOST || '127.0.0.1';
  const BASE_URL = (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const SECURE = BASE_URL.startsWith('https://');
  const REFRESH_MS = (parseInt(env.REFRESH_MINUTES, 10) || 15) * 60 * 1000;
  const ALLOW_PRIVATE_FEEDS = env.ALLOW_PRIVATE_FEEDS === '1';
  const DEV_LOGIN = env.DEV_LOGIN === '1';
  // Personal mode: one owner, no login screen. Only allowed on this device, so nobody else can reach it.
  const SINGLE = env.SINGLE_USER === '1';
  if (SINGLE && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) throw new Error('SINGLE_USER mode has no login, so it only runs on this device (HOST must be 127.0.0.1).');
  const DB_PATH = opts.dbFile || env.DB_FILE || path.join(__dirname, 'data.sqlite');
  const CAL_CONFIG = env.CAL_CONFIG || path.join(path.dirname(DB_PATH), 'calendars.json');
  const db = open(DB_PATH);
  const secret = sec.loadSecret(opts.secretDir || __dirname);
  const cx = sec.makeCrypto(secret);
  const providers = makeProviders(env, opts.providers);
  const configured = () => Object.keys(providers).filter(k => providers[k].clientId && providers[k].clientSecret);

  const q = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    newUser: db.prepare('INSERT INTO users (email, name, created_at) VALUES (?, ?, ?)'),
    identByProvSub: db.prepare('SELECT * FROM identities WHERE provider = ? AND sub = ?'),
    identsOfUser: db.prepare('SELECT * FROM identities WHERE user_id = ?'),
    identById: db.prepare('SELECT * FROM identities WHERE id = ? AND user_id = ?'),
    newIdent: db.prepare('INSERT INTO identities (user_id, provider, sub, email, refresh_enc) VALUES (?, ?, ?, ?, ?)'),
    setRefresh: db.prepare('UPDATE identities SET refresh_enc = ?, email = ? WHERE id = ?'),
    delIdent: db.prepare('DELETE FROM identities WHERE id = ? AND user_id = ?'),
    srcsOfUser: db.prepare('SELECT * FROM sources WHERE user_id = ? ORDER BY rowid'),
    srcsOfIdent: db.prepare('SELECT * FROM sources WHERE identity_id = ?'),
    srcById: db.prepare('SELECT * FROM sources WHERE id = ? AND user_id = ?'),
    newSrc: db.prepare('INSERT OR IGNORE INTO sources (id, user_id, kind, identity_id, ext_id, name, grp, color, url_enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    updSrc: db.prepare('UPDATE sources SET name = ?, grp = ?, color = ? WHERE id = ? AND user_id = ?'),
    delSrc: db.prepare('DELETE FROM sources WHERE id = ? AND user_id = ? AND kind = \'ics\''),
    countIcs: db.prepare('SELECT COUNT(*) AS n FROM sources WHERE user_id = ? AND kind = \'ics\''),
    allUsers: db.prepare('SELECT id FROM users'),
    delUser: db.prepare('DELETE FROM users WHERE id = ?'),
    bumpSession: db.prepare('UPDATE users SET session_v = session_v + 1 WHERE id = ?'),
  };

  const cache = new Map();          // sourceId -> { kind, events|occ, updatedAt, error }
  const tokens = new Map();         // identityId -> { token, exp }
  const lastManual = new Map();     // userId -> ms
  const GROUPS = ['private', 'college', 'work'];
  const rid = () => crypto.randomBytes(5).toString('hex');
  const nextColor = uid => PALETTE[q.srcsOfUser.all(uid).length % PALETTE.length];

  // Personal mode: calendars listed in calendars.json (next to the database) are added automatically at start.
  // Format: [{ "name": "FER", "group": "college", "url": "https://..." }]. Adding the same link twice is ignored.
  function seedFromFile() {
    if (!SINGLE) return;
    let list;
    try { list = JSON.parse(fs.readFileSync(CAL_CONFIG, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') console.error('calendars.json could not be read: ' + e.message); return; }
    if (!Array.isArray(list)) { console.error('calendars.json must be a list [ {...}, {...} ]'); return; }
    const user = soleUser(); let added = 0;
    for (const c of list) {
      const url = c && typeof c.url === 'string' ? c.url.trim() : '';
      if (!/^(https?|webcal):\/\//i.test(url)) { console.error(`calendars.json: skipped "${c && c.name}" (it needs a link starting with https://)`); continue; }
      const id = crypto.createHash('sha256').update(url).digest('hex').slice(0, 10);
      const color = /^#[0-9a-f]{6}$/i.test((c && c.color) || '') ? c.color : nextColor(user.id);
      added += q.newSrc.run(id, user.id, 'ics', null, null, String(c.name || 'Calendar').slice(0, 60), GROUPS.includes(c.group) ? c.group : 'private', color, cx.encrypt(url)).changes;
    }
    if (added) console.log(`Added ${added} calendar(s) from calendars.json`);
  }

  // ---------- provider access ----------
  async function formPost(url, params) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(params) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) { const e = new Error(j.error_description || j.error || `HTTP ${r.status}`); e.code = j.error; throw e; }
    return j;
  }

  async function accessToken(ident) {
    const hit = tokens.get(ident.id);
    if (hit && hit.exp > Date.now() + 60000) return hit.token;
    const p = providers[ident.provider];
    if (!ident.refresh_enc) throw new Error(`Reconnect ${p.label} to keep this calendar updating`);
    try {
      const j = await formPost(p.tokenUrl, { grant_type: 'refresh_token', refresh_token: cx.decrypt(ident.refresh_enc), client_id: p.clientId, client_secret: p.clientSecret, scope: p.scope });
      tokens.set(ident.id, { token: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 });
      if (j.refresh_token) q.setRefresh.run(cx.encrypt(j.refresh_token), ident.email, ident.id);
      return j.access_token;
    } catch (e) {
      if (e.code === 'invalid_grant') throw new Error(`${p.label} access expired. Reconnect ${p.label}.`);
      throw e;
    }
  }

  const getter = token => async (url, headers = {}) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers } });
    if (!r.ok) throw new Error(`Calendar service answered HTTP ${r.status}`);
    return r.json();
  };

  async function syncIdentity(ident) {
    const p = providers[ident.provider];
    if (!p) return;
    let get;
    try {
      get = getter(await accessToken(ident));
      for (const c of await p.listCalendars(get)) {
        q.newSrc.run(rid(), ident.user_id, 'api', ident.id, c.id, c.name, p.defaultGroup, /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : nextColor(ident.user_id), null);
      }
    } catch (e) {
      for (const s of q.srcsOfIdent.all(ident.id)) setErr(s.id, e.message);
      return;
    }
    const from = new Date(Date.now() - WINDOW_BACK).toISOString(), to = new Date(Date.now() + WINDOW_FWD).toISOString();
    await Promise.all(q.srcsOfIdent.all(ident.id).map(async s => {
      try { cache.set(s.id, { kind: 'api', occ: await p.fetchEvents(get, s.ext_id, from, to), updatedAt: Date.now(), error: null }); }
      catch (e) { setErr(s.id, e.message); }
    }));
  }

  function setErr(id, message) {
    const prev = cache.get(id) || {};
    cache.set(id, { ...prev, updatedAt: prev.updatedAt || null, error: message });  // keep last good data
  }

  async function syncIcs(src) {
    try {
      const text = await sec.fetchText(cx.decrypt(src.url_enc), { allowPrivate: ALLOW_PRIVATE_FEEDS });
      if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link did not return a calendar (.ics) file');
      cache.set(src.id, { kind: 'ics', events: parseICS(text), updatedAt: Date.now(), error: null });
    } catch (e) { setErr(src.id, e.message); }
  }

  async function syncUser(uid) {
    await Promise.all([
      ...q.identsOfUser.all(uid).map(syncIdentity),
      ...q.srcsOfUser.all(uid).filter(s => s.kind === 'ics').map(syncIcs),
    ]);
  }
  async function syncAll() {
    const ids = q.allUsers.all().map(u => u.id);
    for (let i = 0; i < ids.length; i += 4) await Promise.allSettled(ids.slice(i, i + 4).map(syncUser));
  }

  // ---------- http helpers ----------
  const HEADERS = {
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  };
  function send(res, code, body, type = 'application/json', extra = {}) {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...HEADERS, ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }
  const redirect = (res, to, cookies = []) => { res.writeHead(302, { Location: to, 'Set-Cookie': cookies, ...HEADERS }); res.end(); };
  const readBody = req => new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) { req.destroy(); reject(new Error('Too large')); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('Bad JSON')); } });
  });
  const sessionCookie = (uid, sv) => sec.cookie('sid', cx.sign({ u: uid, sv, exp: Date.now() + SESSION_MS }), { maxAge: SESSION_MS / 1000, secure: SECURE });
  const clearCookie = name => sec.cookie(name, '', { maxAge: 0, secure: SECURE });
  let soleUserId = null;
  function soleUser() {
    if (!soleUserId) {
      const r = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
      soleUserId = r ? r.id : Number(q.newUser.run('me@local', 'Me', Date.now()).lastInsertRowid);
    }
    return q.userById.get(soleUserId);
  }
  function currentUser(req) {
    if (SINGLE) return soleUser();
    const s = cx.verify(sec.parseCookies(req.headers.cookie).sid);
    if (!s) return null;
    const u = q.userById.get(s.u);
    return u && u.session_v === s.sv ? u : null;
  }
  const publicSrc = s => { const k = cache.get(s.id) || {}; return { id: s.id, kind: s.kind, name: s.name, group: s.grp, color: s.color, updatedAt: k.updatedAt || null, error: k.error || null, count: (k.events || k.occ || []).length }; };

  // ---------- OAuth ----------
  const pkce = () => { const v = crypto.randomBytes(32).toString('base64url'); return { v, c: crypto.createHash('sha256').update(v).digest('base64url') }; };
  const redirectUri = name => `${BASE_URL}/auth/${name}/callback`;

  function oauthStart(req, res, name) {
    const p = providers[name];
    if (!p || !p.clientId) return send(res, 404, 'That sign-in method is not set up', 'text/plain');
    const state = crypto.randomBytes(16).toString('hex'), k = pkce();
    const url = new URL(p.authUrl);
    for (const [a, b] of Object.entries({ client_id: p.clientId, redirect_uri: redirectUri(name), response_type: 'code', scope: p.scope, state, code_challenge: k.c, code_challenge_method: 'S256', ...p.extraAuth })) url.searchParams.set(a, b);
    redirect(res, url.toString(), [sec.cookie('oas', cx.sign({ n: name, s: state, v: k.v, exp: Date.now() + 600000 }), { maxAge: 600, secure: SECURE })]);
  }

  async function oauthCallback(req, res, name, url) {
    const p = providers[name], st = cx.verify(sec.parseCookies(req.headers.cookie).oas);
    const fail = msg => redirect(res, '/?login_error=' + encodeURIComponent(msg), [clearCookie('oas')]);
    if (!p || !st || st.n !== name || st.s !== url.searchParams.get('state')) return fail('Sign-in expired. Please try again.');
    if (url.searchParams.get('error') || !url.searchParams.get('code')) return fail('Sign-in was cancelled.');
    let tok, prof;
    try {
      tok = await formPost(p.tokenUrl, { grant_type: 'authorization_code', code: url.searchParams.get('code'), client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: redirectUri(name), code_verifier: st.v });
      prof = p.profile(await getter(tok.access_token)(p.profileUrl));
    } catch (e) { return fail(`${p.label} sign-in failed: ${e.message}`); }

    const me = currentUser(req);
    let ident = q.identByProvSub.get(name, prof.sub), user;
    if (ident) {
      if (me && me.id !== ident.user_id) return fail(`That ${p.label} account is already connected to a different user.`);
      user = q.userById.get(ident.user_id);
      q.setRefresh.run(tok.refresh_token ? cx.encrypt(tok.refresh_token) : ident.refresh_enc, prof.email, ident.id);
    } else {
      if (me) user = me;                                    // already signed in: connect this account to the current user
      else user = q.userById.get(Number(q.newUser.run(prof.email, prof.name, Date.now()).lastInsertRowid));
      q.newIdent.run(user.id, name, prof.sub, prof.email, tok.refresh_token ? cx.encrypt(tok.refresh_token) : null);
    }
    ident = q.identByProvSub.get(name, prof.sub);
    tokens.set(ident.id, { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3000) * 1000 });
    syncIdentity(ident).catch(() => {});
    redirect(res, '/', [sessionCookie(user.id, user.session_v), clearCookie('oas')]);
  }

  // ---------- routes ----------
  async function handle(req, res) {
    const url = new URL(req.url, BASE_URL);
    const p = url.pathname, m = req.method;
    // Personal mode: only answer requests addressed to this device (blocks DNS-rebinding tricks from web pages).
    if (SINGLE && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, 'Forbidden', 'text/plain');
    if (SINGLE && p.startsWith('/auth/')) return send(res, 404, { error: 'Not available in personal mode' });

    if (m === 'GET' && (p === '/auth/google/start' || p === '/auth/microsoft/start')) return oauthStart(req, res, p.split('/')[2]);
    if (m === 'GET' && (p === '/auth/google/callback' || p === '/auth/microsoft/callback')) return oauthCallback(req, res, p.split('/')[2], url);

    if (p === '/.well-known/assetlinks.json') {   // lets the Android app (Trusted Web Activity) open this site full-screen
      const pkg = env.ANDROID_PACKAGE, fp = (env.ANDROID_SHA256 || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!pkg || !fp.length) return send(res, 404, 'Not configured', 'text/plain');
      return send(res, 200, [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fp } }]);
    }

    if (p.startsWith('/api/') || p.startsWith('/auth/')) {
      if (m === 'GET' && p === '/api/config') return send(res, 200, { providers: configured().map(k => ({ id: k, label: providers[k].label })), devLogin: DEV_LOGIN, single: SINGLE, version: VERSION });
      // CSRF: state-changing requests must carry a custom header that cross-site pages cannot send
      if (m !== 'GET' && req.headers['x-csrf'] !== '1') return send(res, 403, { error: 'Forbidden' });

      if (m === 'POST' && p === '/auth/dev' && DEV_LOGIN) {
        const b = await readBody(req); const email = String(b.email || '').trim().toLowerCase();
        if (!/^\S+@\S+$/.test(email)) return send(res, 400, { error: 'Enter an email' });
        let id = q.identByProvSub.get('dev', email);
        if (!id) { const u = q.newUser.run(email, email, Date.now()); q.newIdent.run(Number(u.lastInsertRowid), 'dev', email, email, null); id = q.identByProvSub.get('dev', email); }
        const user = q.userById.get(id.user_id);
        return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': sessionCookie(user.id, user.session_v) });
      }
      if (m === 'POST' && p === '/auth/logout') return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': clearCookie('sid') });

      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'Please sign in' });

      if (m === 'GET' && p === '/api/me') {
        return send(res, 200, { single: SINGLE, version: VERSION, name: user.name, email: user.email, identities: q.identsOfUser.all(user.id).map(i => ({ id: i.id, provider: i.provider, email: i.email })), available: configured().map(k => ({ id: k, label: providers[k].label })) });
      }
      if (m === 'POST' && p === '/auth/logout-everywhere') { q.bumpSession.run(user.id); return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': clearCookie('sid') }); }
      if (m === 'DELETE' && p === '/api/me') { q.delUser.run(user.id); return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': clearCookie('sid') }); }

      let mm;
      if (m === 'DELETE' && (mm = /^\/api\/identities\/(\d+)$/.exec(p))) {
        const idents = q.identsOfUser.all(user.id);
        if (idents.length <= 1) return send(res, 400, { error: 'You need at least one connected account to sign in.' });
        q.delIdent.run(Number(mm[1]), user.id); tokens.delete(Number(mm[1]));
        return send(res, 200, { ok: true });
      }

      if (m === 'GET' && p === '/api/calendars') return send(res, 200, q.srcsOfUser.all(user.id).map(publicSrc));

      if (m === 'POST' && p === '/api/calendars') {
        const b = await readBody(req);
        if (!/^(https?|webcal):\/\//i.test(String(b.url || ''))) return send(res, 400, { error: 'Paste the calendar\'s private .ics link (starts with https:// or webcal://)' });
        if (q.countIcs.get(user.id).n >= MAX_ICS_PER_USER) return send(res, 400, { error: 'Calendar limit reached' });
        const id = rid();
        q.newSrc.run(id, user.id, 'ics', null, null, String(b.name || 'Calendar').slice(0, 60), GROUPS.includes(b.group) ? b.group : 'private', /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : nextColor(user.id), cx.encrypt(String(b.url).trim()));
        await syncIcs(q.srcById.get(id, user.id));
        return send(res, 201, publicSrc(q.srcById.get(id, user.id)));
      }
      if (m === 'PATCH' && (mm = /^\/api\/calendars\/([a-f0-9]+)$/.exec(p))) {
        const s = q.srcById.get(mm[1], user.id); if (!s) return send(res, 404, { error: 'Not found' });
        const b = await readBody(req);
        q.updSrc.run(b.name ? String(b.name).slice(0, 60) : s.name, GROUPS.includes(b.group) ? b.group : s.grp, /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : s.color, s.id, user.id);
        return send(res, 200, publicSrc(q.srcById.get(s.id, user.id)));
      }
      if (m === 'DELETE' && (mm = /^\/api\/calendars\/([a-f0-9]+)$/.exec(p))) {
        const r = q.delSrc.run(mm[1], user.id); cache.delete(mm[1]);
        return r.changes ? send(res, 200, { ok: true }) : send(res, 400, { error: 'Calendars from a connected account can be hidden with the checkbox, or disconnect the account.' });
      }

      if (m === 'POST' && p === '/api/refresh') {
        if (Date.now() - (lastManual.get(user.id) || 0) > 20000) { lastManual.set(user.id, Date.now()); await syncUser(user.id); }
        return send(res, 200, q.srcsOfUser.all(user.id).map(publicSrc));
      }

      if (m === 'GET' && p === '/api/events') {
        const from = Date.parse(url.searchParams.get('from')), to = Date.parse(url.searchParams.get('to'));
        if (isNaN(from) || isNaN(to) || to <= from || to - from > 400 * 86400000) return send(res, 400, { error: 'bad range' });
        const out = [];
        for (const s of q.srcsOfUser.all(user.id)) {
          const k = cache.get(s.id); if (!k) continue;
          const list = k.kind === 'ics' ? expand(k.events, from, to) : k.occ.filter(e => e.end > from && e.start < to);
          for (const e of list) out.push({ ...e, calId: s.id, calName: s.name, color: s.color, group: s.grp });
        }
        out.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
        return send(res, 200, out);
      }
      return send(res, 404, { error: 'Not found' });
    }

    // static files
    const full = path.normalize(path.join(PUBLIC_DIR, p === '/' ? '/index.html' : p));
    if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(full, (err, data) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      send(res, 200, data, MIME[path.extname(full)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => { if (!res.headersSent) send(res, 500, { error: 'Something went wrong' }); console.error(err.message); });
  });
  let timer;
  server.start = () => new Promise(resolve => {
    server.listen(PORT, HOST, () => {
      try { seedFromFile(); } catch (e) { console.error('calendars.json: ' + e.message); }
      syncAll().catch(() => {});
      timer = setInterval(() => syncAll().catch(() => {}), REFRESH_MS); timer.unref();
      resolve(server);
    });
  });
  server.stop = () => { clearInterval(timer); server.close(); db.close(); };
  server.baseUrl = () => `http://127.0.0.1:${server.address().port}`;
  server.syncUser = syncUser;
  return server;
}

if (require.main === module) {
  const s = create();
  s.start().then(() => {
    const port = s.address().port;
    console.log(`Unified Calendar running on port ${port}`);
    if (process.env.DEV_LOGIN === '1') console.log('WARNING: DEV_LOGIN is on. Anyone who can reach this server can sign in. Use only on your own computer.');
  });
}
module.exports = { create };
