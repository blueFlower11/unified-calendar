# Unified Calendar

One calendar that merges your **private (Google)**, **work (Outlook/Microsoft 365)** and **college (any .ics link)** calendars
and keeps them up to date automatically. Works as a **web app** and an installable **Android app**; each person signs in with
Google or Microsoft and sees only their own calendars.

No npm packages. Needs Node 22.5+ (uses the built-in SQLite).

## Try it on your own computer (2 minutes)

    DEV_LOGIN=1 node server.js
    # open http://localhost:3000, type any email, then use "+ Add calendar link" with an .ics link

`DEV_LOGIN` is a shortcut login for testing only. Never turn it on for a server other people can reach.

## Run it on your Android phone (Termux)

The app runs on the phone itself, with no hosting and no accounts.

1. Install **Termux from F-Droid** (f-droid.org). The Play Store version is outdated and will not work.
2. Open Termux and paste this (first time only):

       pkg install -y git && git clone https://github.com/blueFlower11/unified-calendar && bash unified-calendar/scripts/termux.sh

3. When it says "Unified Calendar is starting", open **http://localhost:3000** in Chrome on the same phone.
   Enter any email on the test login, then **+ Add calendar link** and paste an .ics link.
4. Optional: in Chrome tap **⋮ → Install app** to get a home-screen icon.

Later, to get the newest version, open Termux, press the up arrow to bring back the last command (or type
`bash unified-calendar/scripts/termux.sh`) and run it. It downloads updates first, then starts.
Stop the app with **Ctrl+C**. The app only runs while Termux is open, so keep it in the background (not swiped away).
Your data is kept in `~/.unified-calendar/` and survives updates.

## Test it on your phone with GitHub Codespaces (free)

1. Open this repo on github.com in your phone's browser (tip: use "Desktop site" if the buttons are hidden).
2. Tap **Code → Codespaces → Create codespace on main**. The first start takes 1-2 minutes.
3. The app starts by itself. Open the **Ports** tab and tap the link next to port **3000**
   (it is private: only you, signed in to GitHub, can open it).
4. Enter any email on the test login, then **+ Add calendar link** and paste an .ics link.

The Codespace stops after about 30 minutes of inactivity and your free monthly hours apply.
Your test data stays in the Codespace until you delete it.

## Put it online (needed for the Android app and for real Google/Microsoft sign-in)

You need a host with HTTPS and a domain (any small VPS, Fly.io, Railway, Render... the `Dockerfile` works for all of them;
keep `/data` on a persistent volume).

1. Copy `.env.example` to `.env` and set `BASE_URL`, `APP_SECRET` (a long random string) and the keys below.
2. **Google:** Google Cloud Console → create a project → enable *Google Calendar API* → OAuth consent screen → Credentials →
   *OAuth client ID* (Web application). Add redirect URI `https://YOUR-DOMAIN/auth/google/callback`.
   (While the app is in "Testing" mode only people you add as test users can sign in. Publishing for everyone needs Google's review
   because calendar access is a sensitive scope.)
3. **Microsoft:** Entra admin center → App registrations → New (accounts in any org directory + personal accounts) →
   redirect URI `https://YOUR-DOMAIN/auth/microsoft/callback` (type Web) → add delegated permission `Calendars.Read` and a client secret.
   Some companies require an admin to approve the app before staff can use it.
4. Start: `node --env-file=.env server.js`

How it works: signing in with Google creates your account and pulls in all your Google calendars. Signed in already? Press 👤 →
*Connect Microsoft* to add your Outlook calendars to the same account. College timetables: **+ Add calendar link** and paste the .ics link.
Everything refreshes every 15 minutes (`REFRESH_MINUTES`) and whenever the app is opened.

## Android app

The Android app is this same website in a full-screen Trusted Web Activity (it runs in Chrome, which Google sign-in requires;
Google blocks sign-in inside ordinary embedded web views). It is installable already as a PWA:
open your site in Chrome on Android → ⋮ → *Install app*.

For a real APK / Play Store listing, without writing any Android code:

1. Go to **pwabuilder.com**, enter your site's URL, choose *Android* and download the package (it also gives you a signing key).
2. Put the package name and the SHA-256 fingerprint of that signing key in `.env` as `ANDROID_PACKAGE` and `ANDROID_SHA256`
   and restart. The server then serves `/.well-known/assetlinks.json`, which makes the app open without a browser address bar.
3. Install the APK on your phone to test, or upload the `.aab` to the Play Console.

## Privacy and security notes

- Calendars are read-only (`calendar.readonly` / `Calendars.Read`); nothing is ever written to your accounts.
- Sign-in tokens and private calendar links are encrypted in the database with `APP_SECRET`. Sessions are signed HttpOnly cookies.
- Users can disconnect accounts, sign out everywhere, or delete their account and all stored data from the 👤 menu.
- Calendar links pasted by users cannot point at internal network addresses (protects your server from being used to probe itself).
- Not built yet: rate limiting on sign-in, email notifications, editing events, push notifications.

## Tests

    npm test
