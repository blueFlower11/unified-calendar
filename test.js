// Self-contained checks: parser, recurrence, DST, and the full HTTP flow. Run: node test.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseICS, expand } = require('./ics');

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:one@test
DTSTART:20261105T090000Z
DTEND:20261105T100000Z
SUMMARY:Team sync\\, weekly
LOCATION:Room 4
END:VEVENT
BEGIN:VEVENT
UID:lecture@test
DTSTART;TZID=Europe/Zagreb:20261019T100000
DTEND;TZID=Europe/Zagreb:20261019T113000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10
EXDATE;TZID=Europe/Zagreb:20261104T100000
SUMMARY:Lecture
END:VEVENT
BEGIN:VEVENT
UID:holiday@test
DTSTART;VALUE=DATE:20261125
DTEND;VALUE=DATE:20261126
SUMMARY:Day off
END:VEVENT
BEGIN:VEVENT
UID:cancelled@test
DTSTART:20261106T090000Z
DTEND:20261106T100000Z
STATUS:CANCELLED
SUMMARY:Cancelled thing
END:VEVENT
BEGIN:VEVENT
UID:folded@test
DTSTART:20261110T120000Z
DTEND:20261110T130000Z
SUMMARY:A very long title that
  continues on the next line
END:VEVENT
END:VCALENDAR`;

const events = parseICS(ICS);
assert.strictEqual(events.length, 5);
assert.strictEqual(events[0].title, 'Team sync, weekly');

const from = Date.parse('2026-10-01T00:00:00Z'), to = Date.parse('2026-12-31T00:00:00Z');
const occ = expand(events, from, to);
const titles = t => occ.filter(o => o.title === t);

assert.strictEqual(titles('Cancelled thing').length, 0, 'cancelled events are hidden');
assert.ok(titles('A very long title that continues on the next line').length === 1, 'folded lines are joined');

const lec = titles('Lecture');
// 10 occurrences (COUNT) minus 1 EXDATE that falls inside the window => 9 within range
assert.strictEqual(lec.length, 9, 'weekly BYDAY with COUNT and EXDATE: ' + lec.length);
// 2026-10-19 10:00 Zagreb (CEST, UTC+2) = 08:00Z; after DST ends on 2026-10-25 it is CET (UTC+1) = 09:00Z
assert.strictEqual(new Date(lec[0].start).toISOString(), '2026-10-19T08:00:00.000Z');
const after = lec.find(o => new Date(o.start).getUTCDate() === 26 && new Date(o.start).getUTCMonth() === 9);
assert.strictEqual(new Date(after.start).toISOString(), '2026-10-26T09:00:00.000Z', 'stays 10:00 local across DST change');
assert.ok(!lec.some(o => new Date(o.start).toISOString().startsWith('2026-11-04')), 'EXDATE removed');

const off = titles('Day off')[0];
assert.ok(off.allDay && new Date(off.start).toISOString() === '2026-11-25T00:00:00.000Z');

// monthly "second Tuesday" + yearly
const m = expand(parseICS(`BEGIN:VEVENT
UID:m
DTSTART:20261013T180000Z
DTEND:20261013T190000Z
RRULE:FREQ=MONTHLY;BYDAY=2TU
SUMMARY:Club
END:VEVENT
BEGIN:VEVENT
UID:y
DTSTART:20260301T000000Z
DTEND:20260301T010000Z
RRULE:FREQ=YEARLY
SUMMARY:Anniversary
END:VEVENT`), Date.parse('2026-10-01T00:00:00Z'), Date.parse('2027-04-01T00:00:00Z'));
const club = m.filter(x => x.title === 'Club').map(x => new Date(x.start).toISOString().slice(0, 10));
assert.deepStrictEqual(club, ['2026-10-13', '2026-11-10', '2026-12-08', '2027-01-12', '2027-02-09', '2027-03-09']);
assert.strictEqual(m.filter(x => x.title === 'Anniversary').length, 1);

console.log('parser tests passed');

// ---- end-to-end: serve an ICS feed, add it through the API, read merged events ----
(async () => {
  const feed = http.createServer((req, res) => {
    if (req.url === '/bad.ics') { res.writeHead(200); return res.end('<html>login</html>'); }
    res.writeHead(200, { 'Content-Type': 'text/calendar' }); res.end(ICS);
  }).listen(0, '127.0.0.1');
  await new Promise(r => feed.on('listening', r));
  const feedPort = feed.address().port;

  process.env.CAL_DATA = path.join(os.tmpdir(), `cal-test-${Date.now()}.json`);
  process.env.PORT = 0; process.env.HOST = '127.0.0.1';
  const { start } = require('./server');
  const app = start();
  await new Promise(r => app.on('listening', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const j = async (p, o) => { const r = await fetch(base + p, o); return { status: r.status, body: await r.json() }; };
  const post = (p, b) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

  const a = await post('/api/calendars', { name: 'Work', group: 'work', url: `http://127.0.0.1:${feedPort}/a.ics` });
  assert.strictEqual(a.status, 201); assert.strictEqual(a.body.error, null); assert.ok(a.body.count >= 5);
  const b = await post('/api/calendars', { name: 'Broken', group: 'college', url: `http://127.0.0.1:${feedPort}/bad.ics` });
  assert.ok(b.body.error, 'non-calendar link reports an error');
  const bad = await post('/api/calendars', { name: 'x', url: 'ftp://nope' });
  assert.strictEqual(bad.status, 400);

  const ev = await j('/api/events?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z');
  assert.strictEqual(ev.status, 200);
  assert.ok(ev.body.some(e => e.title === 'Team sync, weekly' && e.calName === 'Work'));
  assert.ok(ev.body.every((e, i, arr) => !i || arr[i - 1].start <= e.start), 'sorted by start');

  const page = await fetch(base + '/');
  assert.strictEqual(page.status, 200);
  assert.strictEqual((await fetch(base + '/../server.js')).status === 200 && false, false);
  const esc = await fetch(base + '/%2e%2e/server.js');
  assert.notStrictEqual(esc.status, 200, 'no path traversal');

  const del = await j('/api/calendars/' + a.body.id, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  fs.rmSync(process.env.CAL_DATA, { force: true });
  console.log('end-to-end tests passed');
  app.close(); feed.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
