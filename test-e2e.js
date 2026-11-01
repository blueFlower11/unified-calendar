// End-to-end: sign-in with a fake Google/Microsoft, linking, sync, isolation, security. Run: node test-e2e.js
const assert = require('assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { create } = require('./server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-test-'));
const tokens = { codeA: ['atA', 'rtA'], codeB: ['atB', 'rtB'], codeM: ['atM', 'rtM'] };
const refreshes = { rtA: 'atA2', rtB: 'atB2', rtM: 'atM2' };
const profiles = { atA: { sub: 'sA', email: 'a@gmail.test', name: 'Anna' }, atA2: { sub: 'sA', email: 'a@gmail.test', name: 'Anna' }, atB: { sub: 'sB', email: 'b@gmail.test', name: 'Ben' },
  atM: { id: 'mA', mail: 'anna@work.test', displayName: 'Anna W' }, atM2: { id: 'mA', mail: 'anna@work.test', displayName: 'Anna W' } };
const calls = [];

// ---- fake Google / Microsoft / ICS host ----
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const bearer = (req.headers.authorization || '').replace('Bearer ', '');
  const json = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  calls.push(u.pathname);
  if (u.pathname === '/token') {
    let d = ''; req.on('data', c => d += c); req.on('end', () => {
      const f = new URLSearchParams(d);
      if (f.get('grant_type') === 'authorization_code') {
        if (!f.get('code_verifier')) return json({ error: 'invalid_request' }, 400);   // PKCE must be sent
        const t = tokens[f.get('code')]; if (!t) return json({ error: 'invalid_grant' }, 400);
        return json({ access_token: t[0], refresh_token: t[1], expires_in: 3600 });
      }
      const at = refreshes[f.get('refresh_token')]; if (!at) return json({ error: 'invalid_grant', error_description: 'revoked' }, 400);
      json({ access_token: at, expires_in: 3600 });
    }); return;
  }
  if (u.pathname.endsWith('.ics')) { res.writeHead(200); return res.end('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:i1\nDTSTART:20261106T100000Z\nDTEND:20261106T110000Z\nSUMMARY:College lecture\nEND:VEVENT\nEND:VCALENDAR'); }
  if (!profiles[bearer]) return json({ error: 'unauthorized' }, 401);
  if (u.pathname === '/profile' || u.pathname === '/graph/me') return json(profiles[bearer]);
  const isB = bearer.startsWith('atB');
  if (u.pathname === '/gcal/users/me/calendarList') return json({ items: [{ id: 'primary', summary: isB ? 'Ben' : 'Anna', backgroundColor: '#112233' }] });
  if (u.pathname === '/gcal/calendars/primary/events') return json({ items: isB
    ? [{ id: 'b1', summary: 'Ben secret', start: { dateTime: '2026-11-05T09:00:00Z' }, end: { dateTime: '2026-11-05T10:00:00Z' } }]
    : [{ id: 'g1', summary: 'Dentist', location: 'Zagreb', start: { dateTime: '2026-11-05T09:00:00+01:00' }, end: { dateTime: '2026-11-05T10:00:00+01:00' } },
       { id: 'g2', summary: 'Birthday', start: { date: '2026-11-10' }, end: { date: '2026-11-11' } },
       { id: 'g3', summary: 'Dropped', status: 'cancelled', start: { date: '2026-11-12' }, end: { date: '2026-11-13' } }] });
  if (u.pathname === '/graph/me/calendars') return json({ value: [{ id: 'cal1', name: 'Work', hexColor: '#aabbcc' }] });
  if (u.pathname === '/graph/me/calendars/cal1/calendarView') {
    assert.ok(/UTC/.test(req.headers.prefer || ''), 'asks Graph for UTC times');
    if (!u.searchParams.get('page')) return json({ value: [{ id: 'm1', subject: 'Standup', start: { dateTime: '2026-11-05T08:00:00.0000000' }, end: { dateTime: '2026-11-05T08:15:00.0000000' }, isAllDay: false }],
      '@odata.nextLink': `http://127.0.0.1:${fake.address().port}/graph/me/calendars/cal1/calendarView?page=2` });
    return json({ value: [{ id: 'm2', subject: 'Offsite', start: { dateTime: '2026-11-20T00:00:00.0000000' }, end: { dateTime: '2026-11-21T00:00:00.0000000' }, isAllDay: true }] });
  }
  json({ error: 'nope' }, 404);
});

const jar = () => { let c = {}; return { set(h) { for (const x of [].concat(h || [])) { const [k, ...v] = x.split(';')[0].split('='); const val = v.join('='); if (/Max-Age=0/.test(x)) delete c[k]; else c[k] = val; } }, header: () => Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; '), get: k => c[k], raw: c }; };

(async () => {
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const F = `http://127.0.0.1:${fake.address().port}`;
  const providers = { google: { clientId: 'gid', clientSecret: 'gs', authUrl: F + '/authorize', tokenUrl: F + '/token', profileUrl: F + '/profile', api: F + '/gcal' },
    microsoft: { clientId: 'mid', clientSecret: 'ms', authUrl: F + '/authorize', tokenUrl: F + '/token', profileUrl: F + '/graph/me', api: F + '/graph' } };
  const app = create({ port: 0, dbFile: path.join(tmp, 'a.sqlite'), secretDir: tmp, providers, env: { ALLOW_PRIVATE_FEEDS: '1', DEV_LOGIN: '1' } });
  await app.start();
  const B = app.baseUrl();

  const call = async (j, method, p, body, extraHeaders = {}) => {
    const r = await fetch(B + p, { method, redirect: 'manual', headers: { Cookie: j.header(), ...(method !== 'GET' ? { 'X-CSRF': '1' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
    j.set(r.headers.getSetCookie());
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json, loc: r.headers.get('location'), text, headers: r.headers };
  };
  async function signIn(j, provider, code) {
    const s = await call(j, 'GET', `/auth/${provider}/start`);
    assert.strictEqual(s.status, 302); const au = new URL(s.loc);
    assert.strictEqual(au.searchParams.get('code_challenge_method'), 'S256'); assert.ok(au.searchParams.get('state'));
    return call(j, 'GET', `/auth/${provider}/callback?code=${code}&state=${au.searchParams.get('state')}`);
  }
  const EV = '/api/events?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z';

  // 0. nothing works signed out
  const anon = jar();
  assert.strictEqual((await call(anon, 'GET', '/api/calendars')).status, 401);
  assert.deepStrictEqual((await call(anon, 'GET', '/api/config')).json.providers.map(p => p.id), ['google', 'microsoft']);

  // 1. Google sign-in creates a user, a session and syncs calendars
  const anna = jar();
  const cb = await signIn(anna, 'google', 'codeA');
  assert.strictEqual(cb.status, 302); assert.strictEqual(cb.loc, '/');
  assert.ok(/HttpOnly/i.test(cb.headers.getSetCookie().find(c => c.startsWith('sid='))), 'session cookie is HttpOnly');
  const me = await call(anna, 'GET', '/api/me');
  assert.strictEqual(me.json.name, 'Anna'); assert.strictEqual(me.json.identities.length, 1);
  await call(anna, 'POST', '/api/refresh');
  let cals = (await call(anna, 'GET', '/api/calendars')).json;
  assert.strictEqual(cals.length, 1); assert.strictEqual(cals[0].group, 'private'); assert.strictEqual(cals[0].color, '#112233'); assert.strictEqual(cals[0].error, null);
  let ev = (await call(anna, 'GET', EV)).json;
  assert.ok(ev.some(e => e.title === 'Dentist' && e.start === Date.parse('2026-11-05T08:00:00Z')), 'Google event with offset');
  assert.ok(ev.some(e => e.title === 'Birthday' && e.allDay), 'all-day event');
  assert.ok(!ev.some(e => e.title === 'Dropped'), 'cancelled hidden');

  // 2. signed in already -> connecting Microsoft links to the SAME user (work calendar)
  await signIn(anna, 'microsoft', 'codeM');
  assert.strictEqual((await call(anna, 'GET', '/api/me')).json.identities.length, 2);
  await call(anna, 'POST', '/api/refresh');                                  // refresh is rate limited; sync directly instead
  await app.syncUser(1);
  cals = (await call(anna, 'GET', '/api/calendars')).json;
  const work = cals.find(c => c.name === 'Work'); assert.ok(work && work.group === 'work');
  ev = (await call(anna, 'GET', EV)).json;
  assert.ok(ev.some(e => e.title === 'Standup' && e.start === Date.parse('2026-11-05T08:00:00Z')), 'Graph UTC time');
  assert.ok(ev.some(e => e.title === 'Offsite' && e.allDay), 'Graph pagination + all-day');

  // 3. ICS college link, then edit group/colour
  const added = await call(anna, 'POST', '/api/calendars', { name: 'College', group: 'college', url: `${F}/college.ics` });
  assert.strictEqual(added.status, 201); assert.strictEqual(added.json.error, null);
  const patched = await call(anna, 'PATCH', '/api/calendars/' + added.json.id, { name: 'Faks', group: 'college', color: '#ff0000' });
  assert.strictEqual(patched.json.name, 'Faks'); assert.strictEqual(patched.json.color, '#ff0000');
  assert.ok((await call(anna, 'GET', EV)).json.some(e => e.title === 'College lecture' && e.calName === 'Faks'));
  assert.strictEqual((await call(anna, 'DELETE', '/api/calendars/' + work.id)).status, 400, 'account calendars are hidden, not deleted');

  // 4. a second user sees ONLY their own data
  const ben = jar(); await signIn(ben, 'google', 'codeB');
  const bev = (await call(ben, 'GET', EV)).json;
  await new Promise(r => setTimeout(r, 300));
  const bev2 = (await call(ben, 'GET', EV)).json;
  assert.ok(bev2.some(e => e.title === 'Ben secret'));
  assert.ok(![...bev, ...bev2].some(e => ['Dentist', 'Standup', 'College lecture'].includes(e.title)), 'no cross-user leak');
  assert.strictEqual((await call(ben, 'PATCH', '/api/calendars/' + added.json.id, { name: 'hacked' })).status, 404, "cannot edit another user's calendar");
  assert.strictEqual((await call(ben, 'DELETE', '/api/calendars/' + added.json.id)).status, 400);
  assert.ok((await call(anna, 'GET', '/api/calendars')).json.some(c => c.name === 'Faks'), 'still there');

  // 5. connecting an account that belongs to someone else is refused
  tokens.codeX = ['atA', 'rtA'];           // Anna's Google identity again, but presented by Ben
  const steal = await signIn(ben, 'google', 'codeX');
  assert.ok(/already%20connected/.test(steal.loc), 'cannot take over another user\'s linked account');

  // 6. security: CSRF header, tampered cookie, state check, errors, revoked access
  assert.strictEqual((await call(anna, 'POST', '/api/refresh', null, { 'X-CSRF': '' })).status, 403, 'CSRF header required');
  const forged = jar(); forged.raw.sid = anna.get('sid').replace(/.$/, c => c === 'A' ? 'B' : 'A');
  assert.strictEqual((await call(forged, 'GET', '/api/me')).status, 401, 'tampered cookie rejected');
  const s2 = await call(jar(), 'GET', '/auth/google/callback?code=codeA&state=bogus');
  assert.ok(/login_error/.test(s2.loc), 'callback without matching state is rejected');
  refreshes.rtA = undefined;                              // simulate the user revoking access at Google
  const stale = await call(anna, 'GET', '/api/calendars'); assert.strictEqual(stale.status, 200);

  // 7. stored secrets are encrypted at rest
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(path.join(tmp, 'a.sqlite'));
  const idents = raw.prepare('SELECT refresh_enc FROM identities').all().map(r => r.refresh_enc).filter(Boolean);
  assert.ok(idents.length >= 2 && idents.every(x => !/rtA|rtB|rtM/.test(x)), 'refresh tokens not stored in plain text');
  assert.ok(!/college\.ics/.test(raw.prepare('SELECT url_enc FROM sources WHERE url_enc IS NOT NULL').all().map(r => r.url_enc).join('')), 'ICS links encrypted');
  raw.close();

  // 8. logout everywhere kills old sessions; account deletion removes data
  const old = anna.header();
  await call(anna, 'POST', '/auth/logout-everywhere');
  const r = await fetch(B + '/api/me', { headers: { Cookie: old } }); assert.strictEqual(r.status, 401, 'old session invalid');
  const ben2 = jar(); ben2.raw.sid = ben.get('sid');
  assert.strictEqual((await call(ben2, 'DELETE', '/api/me')).status, 200);
  assert.strictEqual((await call(ben2, 'GET', '/api/me')).status, 401);

  // 9. local test login works only because DEV_LOGIN was enabled; static files + traversal
  const dev = jar(); assert.strictEqual((await call(dev, 'POST', '/auth/dev', { email: 'me@test.dev' })).status, 200);
  assert.strictEqual((await call(dev, 'GET', '/api/me')).json.email, 'me@test.dev');
  assert.strictEqual((await call(anon, 'GET', '/')).status, 200);
  assert.strictEqual((await call(anon, 'GET', '/manifest.webmanifest')).status, 200);
  assert.notStrictEqual((await call(anon, 'GET', '/%2e%2e/server.js')).status, 200, 'no path traversal');
  assert.ok((await call(anon, 'GET', '/')).headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  app.stop();

  // 10. a normal (internet-facing) server refuses to fetch internal addresses (SSRF) and has no dev login
  const strict = create({ port: 0, dbFile: path.join(tmp, 'b.sqlite'), secretDir: tmp, providers: {}, env: { DEV_LOGIN: '0', ALLOW_PRIVATE_FEEDS: '0' } });
  await strict.start();
  assert.strictEqual((await fetch(strict.baseUrl() + '/auth/dev', { method: 'POST', headers: { 'X-CSRF': '1' }, body: '{}' })).status, 401, 'dev login off by default');
  strict.stop();
  const strict2 = create({ port: 0, dbFile: path.join(tmp, 'c.sqlite'), secretDir: tmp, providers: {}, env: { DEV_LOGIN: '1', ALLOW_PRIVATE_FEEDS: '0' } });
  await strict2.start();
  const sb = strict2.baseUrl();
  const login = await fetch(sb + '/auth/dev', { method: 'POST', headers: { 'X-CSRF': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 's@s.test' }) });
  const sc = login.headers.getSetCookie()[0].split(';')[0];
  for (const bad of [`${F}/college.ics`, 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x.ics', 'http://localhost:8080/x.ics', 'http://10.0.0.5/x.ics']) {
    const x = await fetch(sb + '/api/calendars', { method: 'POST', headers: { 'X-CSRF': '1', 'Content-Type': 'application/json', Cookie: sc }, body: JSON.stringify({ name: 'x', url: bad }) });
    const body = await x.json();
    assert.ok(body.error && /not allowed/i.test(body.error), `blocked ${bad}: ${JSON.stringify(body)}`);
  }
  strict2.stop(); fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('end-to-end tests passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
