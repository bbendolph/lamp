# Lamp

Ben's personal daily app: habits, Planet Fitness workouts, tasks and groceries, Bible study, prayer and reading.
It installs to the Home Screen on iPhone and iPad and to the Dock on Mac, works offline, and syncs through Supabase.

## How it fits together
- `index.html`: the whole app (screens, styles, logic).
- `js/store.js`: local-first sync. Saves on the device first, then pushes to Supabase; pulls other devices' changes on open, on reconnect and live.
- `config.js`: your Supabase URL and anon key (public by design; Row Level Security protects the data).
- `setup.sql`: one table, `docs`, locked to your account.
- `seed.json`: starter routines and grocery staples, loaded once on first sign-in.
- `sw.js` + `manifest.webmanifest` + `icons/`: what makes it installable and available offline.

## One-time setup
1. Supabase → SQL Editor → New query → paste `setup.sql` → Run.
2. Put the Project URL and anon key in `config.js`.
3. GitHub → this repo → Settings → Pages → Build and deployment: Deploy from a branch, `main`, `/ (root)` → Save.
4. Supabase → Authentication → URL Configuration → Site URL: your GitHub Pages address.
5. Open the Pages address on each device, sign in, then:
   - iPhone / iPad (Safari): Share → Add to Home Screen
   - Mac (Safari): File → Add to Dock. (Chrome: install icon in the address bar.)

## Updating
Push to `main`. Each device picks up the new version the next time Lamp is opened.
When you change files, bump `VERSION` in `sw.js` so offline copies refresh.
