// Parser, recurrence and DST checks. Run: node test-parser.js
const assert = require('assert');
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

