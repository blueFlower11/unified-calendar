# Unified Calendar

One calendar that merges your private, college and work calendars and keeps them up to date automatically.
No dependencies — just Node 18+.

## Run it

    node server.js
    # open http://localhost:3000

Click **+ Add calendar**, paste each calendar's private `.ics` link, pick Private / College / Work.
The server re-fetches every feed every 15 minutes (`REFRESH_MINUTES=5 node server.js` to change it),
and the open page refreshes itself too. If a feed is temporarily down, the last good copy is kept.

## Getting the links

- **Google:** Calendar settings → your calendar → *Secret address in iCal format*
- **Outlook / Microsoft 365:** Settings → Calendar → Shared calendars → *Publish a calendar* → ICS link
  (some work accounts block this — ask IT)
- **College:** look for *Subscribe / Export / iCal / webcal* in the timetable or LMS

Treat these links like passwords. They are stored in `calendars.json` (git-ignored) and the server
only listens on `localhost` by default.

## Notes

- Read-only: it shows events but doesn't edit your original calendars.
- Supports recurring events (daily/weekly/monthly/yearly, exceptions, DST-correct), all-day events, time zones.
- Tests: `node test.js`
