'use strict';
const $ = id => document.getElementById(id);
const state = { view: window.matchMedia('(max-width: 760px)').matches ? 'agenda' : 'month', cursor: startOfMonth(new Date()), cals: [], events: [], me: null, hidden: new Set(JSON.parse(localStorage.getItem('hidden') || '[]')) };
const GROUP_LABEL = { private: 'Private', college: 'College', work: 'Work' };
const PROVIDER_ICON = { google: 'Google', microsoft: 'Microsoft', dev: 'Local test' };

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const fmtTime = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const safeColor = c => /^#[0-9a-f]{6}$/i.test(c) ? c : '#4f86f7';

// All-day events are stored as UTC midnight; show them on that calendar date in any timezone.
function localStart(e) { if (!e.allDay) return new Date(e.start); const d = new Date(e.start); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
function localEnd(e) { if (!e.allDay) return new Date(e.end); const d = new Date(e.end); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
function occursOn(e, day) {
  const s = localStart(e), en = localEnd(e), d0 = new Date(day.getFullYear(), day.getMonth(), day.getDate()), d1 = addDays(d0, 1);
  return s < d1 && (en > d0 || sameDay(s, d0));
}

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'X-CSRF': '1', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { showLogin(); throw new Error('signed out'); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const post = (p, body) => api(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

// ---------- sign-in ----------
async function showLogin(message) {
  $('appView').classList.add('hidden'); $('loginView').classList.remove('hidden');
  const cfg = await fetch('/api/config').then(r => r.json());
  $('ssoButtons').innerHTML = cfg.providers.map(p => `<a href="/auth/${p.id}/start"><button type="button" class="sso">Continue with ${esc(p.label)}</button></a>`).join('')
    || (cfg.devLogin ? '' : '<p>Sign-in is not set up yet. See the README.</p>');
  $('devForm').classList.toggle('hidden', !cfg.devLogin);
  const err = new URLSearchParams(location.search).get('login_error');
  $('loginMsg').textContent = message || err || '';
  if (err) history.replaceState(null, '', '/');
}
$('devForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  try { await post('/auth/dev', { email: $('devEmail').value }); await boot(); } catch (e) { $('loginMsg').textContent = e.message; }
});

async function boot() {
  try { state.me = await api('/api/me'); } catch { return; }
  $('loginView').classList.add('hidden'); $('appView').classList.remove('hidden');
  renderAccount();
  await load();
}

function renderAccount() {
  const me = state.me, have = new Set(me.identities.map(i => i.provider));
  const connect = me.available.filter(p => !have.has(p.id)).map(p => `<a href="/auth/${p.id}/start"><button type="button">+ Connect ${esc(p.label)} calendars</button></a>`).join('');
  $('acctPop').innerHTML = `<div style="margin-bottom:8px"><b>${esc(me.name)}</b><div class="ok">${esc(me.email)}</div></div>
    <h4>Connected accounts</h4>${me.identities.map(i => `<div class="line"><span>${esc(PROVIDER_ICON[i.provider] || i.provider)} · ${esc(i.email)}</span>${me.identities.length > 1 ? `<button style="width:auto" data-disc="${i.id}">Disconnect</button>` : ''}</div>`).join('')}
    ${connect}<hr style="border:0;border-top:1px solid var(--line);margin:10px 0">
    <button id="signOut">Sign out</button><button id="signOutAll">Sign out everywhere</button><button class="danger" id="delAcct">Delete my account and data</button>`;
}
$('acctBtn').onclick = ev => { ev.stopPropagation(); $('acctPop').classList.toggle('hidden'); };
document.addEventListener('click', ev => { if (!ev.target.closest('.menu')) $('acctPop').classList.add('hidden'); });

// ---------- data ----------
function range() {
  if (state.view === 'month') { const first = startOfMonth(state.cursor); const from = addDays(first, -first.getDay()); return [from, addDays(from, 42)]; }
  return [new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1), new Date(state.cursor.getFullYear(), state.cursor.getMonth() + 1, 1)];
}
async function load() {
  const [from, to] = range();
  const qs = new URLSearchParams({ from: addDays(from, -1).toISOString(), to: addDays(to, 1).toISOString() });
  [state.cals, state.events] = await Promise.all([api('/api/calendars'), api('/api/events?' + qs)]);
  render();
}
const visible = () => state.events.filter(e => !state.hidden.has(e.calId));

// ---------- rendering ----------
function renderSidebar() {
  let html = '';
  for (const g of ['private', 'college', 'work']) {
    const list = state.cals.filter(c => c.group === g);
    if (!list.length) continue;
    html += `<h2>${GROUP_LABEL[g]}</h2>`;
    for (const c of list) {
      const status = c.error ? `<div class="err">⚠ ${esc(c.error)}</div>` : c.updatedAt ? `<div class="ok">${c.count} events · updated ${fmtTime(c.updatedAt)}</div>` : '<div class="ok">Loading…</div>';
      html += `<div style="margin-bottom:6px"><div class="cal" style="--c:${safeColor(c.color)}">
        <input type="checkbox" data-id="${esc(c.id)}" ${state.hidden.has(c.id) ? '' : 'checked'} aria-label="Show ${esc(c.name)}">
        <span class="dot" style="background:${safeColor(c.color)}"></span><span class="name">${esc(c.name)}</span>
        <button class="x" data-edit="${esc(c.id)}" title="Edit">✎</button>
        ${c.kind === 'ics' ? `<button class="x" data-del="${esc(c.id)}" title="Remove">✕</button>` : ''}</div>${status}</div>`;
    }
  }
  $('cals').innerHTML = html || '<div class="empty" style="padding:8px">No calendars yet. Connect an account from 👤, or add a calendar link below.</div>';
}

function renderMonth() {
  const [from] = range(), ev = visible(), today = new Date();
  let html = '<div class="grid">' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const day = addDays(from, i);
    const items = ev.filter(e => occursOn(e, day)).sort((a, b) => (b.allDay - a.allDay) || a.start - b.start);
    const cls = ['day', day.getMonth() !== state.cursor.getMonth() ? 'other' : '', sameDay(day, today) ? 'today' : ''].join(' ');
    html += `<div class="${cls}"><div class="n">${day.getDate()}</div>`;
    for (const e of items.slice(0, 3)) html += `<span class="chip" style="--c:${safeColor(e.color)}" data-ev="${state.events.indexOf(e)}">${e.allDay ? '' : fmtTime(e.start) + ' '}${esc(e.title)}</span>`;
    if (items.length > 3) html += `<div class="more">+${items.length - 3} more</div>`;
    html += '</div>';
  }
  $('view').innerHTML = html + '</div>';
}

function renderAgenda() {
  const [from, to] = range(), ev = visible(), today = new Date();
  let html = '<div class="agenda">', any = false;
  for (let d = new Date(from); d < to; d = addDays(d, 1)) {
    const items = ev.filter(e => occursOn(e, d)).sort((a, b) => (b.allDay - a.allDay) || a.start - b.start);
    if (!items.length) continue;
    any = true;
    html += `<h3 class="${sameDay(d, today) ? 'today' : ''}">${d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</h3>`;
    for (const e of items) html += `<div class="row" style="--c:${safeColor(e.color)}" data-ev="${state.events.indexOf(e)}"><span class="bar"></span>
      <span class="t">${e.allDay ? 'All day' : fmtTime(e.start) + '–' + fmtTime(e.end)}</span>
      <span><div>${esc(e.title)}</div><div class="meta">${esc(e.calName)}${e.location ? ' · ' + esc(e.location) : ''}</div></span></div>`;
  }
  $('view').innerHTML = html + (any ? '' : '<div class="empty">Nothing scheduled this month.</div>') + '</div>';
}

function render() {
  $('title').textContent = state.cursor.toLocaleDateString([], { month: 'long', year: 'numeric' });
  $('vMonth').classList.toggle('on', state.view === 'month');
  $('vAgenda').classList.toggle('on', state.view === 'agenda');
  renderSidebar();
  state.view === 'month' ? renderMonth() : renderAgenda();
}

function showEvent(e) {
  const when = e.allDay ? localStart(e).toLocaleDateString([], { dateStyle: 'full' }) : new Date(e.start).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) + ' – ' + fmtTime(e.end);
  $('evBody').innerHTML = `<h3 style="margin:0 0 4px">${esc(e.title)}</h3>
    <div style="color:var(--muted)"><span class="dot" style="display:inline-block;background:${safeColor(e.color)}"></span> ${esc(e.calName)}</div>
    <p>${esc(when)}</p>${e.location ? `<p>📍 ${esc(e.location)}</p>` : ''}${e.description ? `<p style="white-space:pre-wrap">${esc(e.description)}</p>` : ''}`;
  $('evDlg').showModal();
}

// ---------- interactions ----------
function move(n) { state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + n, 1); load(); }
$('prev').onclick = () => move(-1);
$('next').onclick = () => move(1);
$('today').onclick = () => { state.cursor = startOfMonth(new Date()); load(); };
$('vMonth').onclick = () => { state.view = 'month'; load(); };
$('vAgenda').onclick = () => { state.view = 'agenda'; load(); };
$('refresh').onclick = async () => { $('refresh').disabled = true; try { await post('/api/refresh'); await load(); } finally { $('refresh').disabled = false; } };
$('evClose').onclick = () => $('evDlg').close();

document.addEventListener('click', async ev => {
  const t = ev.target;
  const chip = t.closest('[data-ev]'); if (chip) return showEvent(state.events[+chip.dataset.ev]);
  const del = t.closest('[data-del]');
  if (del && confirm('Remove this calendar link? Your original calendar is not affected.')) { await api('/api/calendars/' + del.dataset.del, { method: 'DELETE' }); return load(); }
  const ed = t.closest('[data-edit]');
  if (ed) { const c = state.cals.find(x => x.id === ed.dataset.edit); $('editForm').dataset.id = c.id; $('eName').value = c.name; $('eGroup').value = c.group; $('eColor').value = safeColor(c.color); return $('editDlg').showModal(); }
  const disc = t.closest('[data-disc]');
  if (disc && confirm('Disconnect this account? Its calendars will disappear from here (nothing is deleted from the account itself).')) { await api('/api/identities/' + disc.dataset.disc, { method: 'DELETE' }); state.me = await api('/api/me'); renderAccount(); return load(); }
  if (t.id === 'signOut') { await post('/auth/logout'); location.reload(); }
  if (t.id === 'signOutAll') { await post('/auth/logout-everywhere'); location.reload(); }
  if (t.id === 'delAcct' && confirm('Delete your account and everything stored about it? This cannot be undone.')) { await api('/api/me', { method: 'DELETE' }); location.reload(); }
});
document.addEventListener('change', ev => {
  const id = ev.target.dataset && ev.target.dataset.id; if (!id) return;
  ev.target.checked ? state.hidden.delete(id) : state.hidden.add(id);
  localStorage.setItem('hidden', JSON.stringify([...state.hidden]));
  render();
});

$('add').onclick = () => { $('fErr').textContent = ''; $('addForm').reset(); $('addDlg').showModal(); };
$('fCancel').onclick = () => $('addDlg').close();
$('eCancel').onclick = () => $('editDlg').close();
$('addForm').addEventListener('submit', async ev => {
  ev.preventDefault(); $('fSave').disabled = true; $('fErr').textContent = '';
  try {
    const c = await post('/api/calendars', { name: $('fName').value, group: $('fGroup').value, url: $('fUrl').value });
    $('addDlg').close(); await load();
    if (c.error) alert('Added, but the first fetch failed: ' + c.error);
  } catch (e) { $('fErr').textContent = e.message; }
  $('fSave').disabled = false;
});
$('editForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  await api('/api/calendars/' + $('editForm').dataset.id, { method: 'PATCH', body: JSON.stringify({ name: $('eName').value, group: $('eGroup').value, color: $('eColor').value }) });
  $('editDlg').close(); load();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
setInterval(() => { if (!document.hidden && state.me) load().catch(() => {}); }, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.me) load().catch(() => {}); });
boot().then(() => { if (!state.me) showLogin(); });
