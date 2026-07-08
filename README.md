# Fleet Board Pro

Vehicle location, delivery request, and fleet status management web app
for shop/company operations. Plain HTML/CSS/JS frontend (installable as
a PWA) with Supabase (PostgreSQL + Auth + Row Level Security) as the
backend.

## Project structure

```
index.html            Login page
admin.html            Admin dashboard (users, outlets, drivers, vehicles)
manager.html          Manager dashboard (requests, jobs, fleet map, history)
outlet.html           Outlet staff dashboard (create/track requests)
driver.html           Driver dashboard (jobs, location sharing)
manifest.webmanifest  PWA manifest (installable app)
sw.js                 Service worker (static cache, offline fallback)
icons/                App icons
css/style.css         Shared styles
js/config.example.js  Supabase config template (copy to js/config.js)
js/supabase-client.js Shared Supabase client (anon key only)
js/auth.js            Session/profile checks, role guard, logout
js/pwa.js             Service worker registration + offline notices
js/ui.js              Shared UI helpers
js/login|admin|manager|outlet|driver.js  Per-page logic
vendor/               Vendored supabase-js and Leaflet (no CDN needed)
supabase/             Database schema, RLS policies, tests, setup guide
```

## Setup

### 1. Database (Supabase)

Follow `supabase/README.md`: run the migration files from
`supabase/migrations/` **in order** in the Supabase SQL Editor, create
your company, and promote the first admin.

### 2. Frontend config

Copy `js/config.example.js` to `js/config.js` and fill in your project
URL and **anon** key (Supabase Dashboard → Project Settings → API).

- `js/config.js` is gitignored — each environment keeps its own.
- The anon key is safe in the browser: Row Level Security protects all
  data. **Never** put the service_role key in this file or anywhere in
  the frontend.

### 3. Serve locally

Any static file server works:

```bash
python3 -m http.server 8000
```

then open http://localhost:8000

### 4. HTTPS note (location sharing)

The browser Geolocation API only works on **HTTPS or localhost**. Local
testing on `http://localhost` is fine; production hosting must be HTTPS
(most static hosts — Netlify, Vercel, Cloudflare Pages, GitHub Pages —
provide it automatically). HTTPS is also required for PWA install.

## Deploy to GitHub Pages (built in)

This repo ships with `.github/workflows/deploy-pages.yml`, which publishes
the app to GitHub Pages (free HTTPS hosting) on every push to `main`:

1. Repo **Settings → Secrets and variables → Actions** → add two secrets:
   `SUPABASE_URL` and `SUPABASE_ANON_KEY` (anon key only — these are
   public values; the secret store just keeps them out of the code).
2. Push to `main` (or run the workflow manually from the Actions tab).
3. The site appears at `https://<owner>.github.io/<repo>/`.

Notes: the repository must be public for free GitHub Pages, and the
workflow generates `js/config.js` at deploy time so nothing is committed.
Any other static host (Netlify, Vercel, Cloudflare Pages) also works —
just upload the files and create `js/config.js` there manually.

## Install as an app (PWA)

On a phone, open the site in the browser, then:

- **Android / Chrome:** menu (⋮) → *Add to Home screen* → *Install*
- **iPhone / Safari:** Share button → *Add to Home Screen*

The app launches full-screen (standalone) from its own icon, with the
static files cached for fast loading. Live data always comes from
Supabase — nothing sensitive is cached, and actions that fail offline
show a clear error instead of pretending they worked.

## Notifications

Live alerts use Supabase Realtime and work **while the app is open**
(foreground or a backgrounded tab/PWA):

- **Drivers** get *"New delivery request available"* when a request they
  can take is created.
- **Outlets** get *"Your delivery has been completed"* for their own
  deliveries.

These always show as an in-app toast. If the user taps **🔔 Enable
alerts** and grants permission, they also appear as an OS/phone
notification (via the service worker) while the app is running.

**Full closed-app push is not implemented.** Delivering a notification
when the app is completely closed requires Web Push — a push
subscription plus a server or Supabase Edge Function that sends the
push. That is a deliberate later step; today, alerts require the app to
be open in the background.

## Live maps

The outlet Track My Deliveries map and the manager vehicle map update
**live** while the page is open: vehicle markers (a van icon) move in
place as new positions arrive over Supabase Realtime, with a gentle
polling fallback. The view auto-fits once, then your zoom/pan is kept.
Row-level security scopes the live events exactly like normal reads —
an outlet only receives the van on its own active delivery; a manager
only receives their company's vehicles.

**Phone limitation for drivers:** browsers pause JS timers and GPS when
the app is fully closed or the screen is locked (especially iOS), so
location updates flow while the driver keeps the app open. The driver
screen says this next to the Share Location button. Continuous
background GPS would require a native app wrapper — out of scope for
now.

## Creating users

Login accounts are created in the **Supabase Dashboard**
(Authentication → Add user) or by users signing up on the login page.
New signups must then be attached to your company — see
`supabase/README.md` for the one-line SQL. After that, an admin manages
role, activation, and outlet/driver links from the Admin Dashboard in
the app. A secure Supabase Edge Function can automate account creation
later; it must never be done from the frontend.

## How login works

- Users sign in with email + password (Supabase Auth).
- The app loads their profile (role, company, active flag) and sends
  them to the dashboard for their role: admin, manager, outlet, driver.
- Dashboards are guarded: not logged in → back to login; wrong role →
  redirected to your own dashboard; inactive profile → signed out with
  a clear message.
- All data access is protected by Row Level Security in the database —
  the frontend never sees another company's data even if modified.

## Roles

| Role    | Sees                                        |
|---------|---------------------------------------------|
| admin   | Full company management                      |
| manager | Requests, jobs, vehicles, driver locations   |
| outlet  | Their outlet's requests only                 |
| driver  | Their own assigned jobs only                 |

## Testing

- Database/RLS: `supabase/tests/smoke_test.sql` (see `supabase/README.md`)
- Deploying a change? Bump `CACHE_VERSION` in `sw.js` so installed
  clients drop the old static cache.
