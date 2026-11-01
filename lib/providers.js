// Google and Microsoft: sign-in (OAuth 2.0 + PKCE) and calendar reading.
// Each provider's calendar functions receive `get(url, headers)` which performs an authorized GET and returns JSON.
const MAX_PAGES = 10;
const deepMerge = (a, b) => { for (const k of Object.keys(b || {})) a[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) ? deepMerge(a[k] || {}, b[k]) : b[k]; return a; };

function makeProviders(env = process.env, overrides = {}) {
  const P = {
    google: {
      label: 'Google', defaultGroup: 'private',
      clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      profileUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      api: 'https://www.googleapis.com/calendar/v3',
      scope: 'openid email profile https://www.googleapis.com/auth/calendar.readonly',
      extraAuth: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
      profile: j => ({ sub: String(j.sub), email: j.email || '', name: j.name || j.email || 'Google user' }),
      async listCalendars(get) {
        const j = await get(`${this.api}/users/me/calendarList?maxResults=250&minAccessRole=reader`);
        return (j.items || []).map(c => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor }));
      },
      async fetchEvents(get, calId, fromIso, toIso) {
        const out = []; let page = '';
        for (let i = 0; i < MAX_PAGES; i++) {
          const q = new URLSearchParams({ singleEvents: 'true', showDeleted: 'false', maxResults: '2500', timeMin: fromIso, timeMax: toIso });
          if (page) q.set('pageToken', page);
          const j = await get(`${this.api}/calendars/${encodeURIComponent(calId)}/events?${q}`);
          for (const it of j.items || []) {
            if (it.status === 'cancelled' || !it.start) continue;
            const allDay = !!it.start.date;
            const start = Date.parse(it.start.dateTime || it.start.date);
            const end = Date.parse((it.end && (it.end.dateTime || it.end.date)) || it.start.dateTime || it.start.date);
            if (isNaN(start)) continue;
            out.push({ uid: it.id, title: it.summary || '(no title)', location: it.location || '', description: it.description || '', start, end: isNaN(end) ? start : end, allDay });
          }
          if (!j.nextPageToken) break; page = j.nextPageToken;
        }
        return out;
      },
    },
    microsoft: {
      label: 'Microsoft', defaultGroup: 'work',
      clientId: env.MS_CLIENT_ID, clientSecret: env.MS_CLIENT_SECRET,
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      profileUrl: 'https://graph.microsoft.com/v1.0/me',
      api: 'https://graph.microsoft.com/v1.0',
      scope: 'openid email profile offline_access User.Read Calendars.Read',
      extraAuth: { prompt: 'select_account' },
      profile: j => ({ sub: String(j.id), email: j.mail || j.userPrincipalName || '', name: j.displayName || j.mail || 'Microsoft user' }),
      async listCalendars(get) {
        const j = await get(`${this.api}/me/calendars?$top=100`);
        return (j.value || []).map(c => ({ id: c.id, name: c.name, color: /^#[0-9a-f]{6}$/i.test(c.hexColor || '') ? c.hexColor : null }));
      },
      async fetchEvents(get, calId, fromIso, toIso) {
        const out = [];
        const q = new URLSearchParams({ startDateTime: fromIso, endDateTime: toIso, $top: '500', $select: 'id,subject,start,end,isAllDay,isCancelled,location,bodyPreview' });
        let url = `${this.api}/me/calendars/${encodeURIComponent(calId)}/calendarView?${q}`;
        for (let i = 0; i < MAX_PAGES && url; i++) {
          const j = await get(url, { Prefer: 'outlook.timezone="UTC"' });
          for (const it of j.value || []) {
            if (it.isCancelled || !it.start) continue;
            const start = Date.parse(String(it.start.dateTime).slice(0, 19) + 'Z');
            const end = Date.parse(String((it.end || it.start).dateTime).slice(0, 19) + 'Z');
            if (isNaN(start)) continue;
            out.push({ uid: it.id, title: it.subject || '(no title)', location: (it.location && it.location.displayName) || '', description: it.bodyPreview || '', start, end: isNaN(end) ? start : end, allDay: !!it.isAllDay });
          }
          url = j['@odata.nextLink'] || null;
        }
        return out;
      },
    },
  };
  return deepMerge(P, overrides);
}
module.exports = { makeProviders };
