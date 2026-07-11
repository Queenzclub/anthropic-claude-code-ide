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

## Driver navigation map

When a request carries pickup/drop-off map pins (set optionally on the
outlet or manager request form), the driver sees them on each job card:
a compact map with a green **P**ickup and red **D**rop-off marker, and
buttons that hand off to the phone's map app — **Open Pickup in Maps**,
**Open Drop-off in Maps**, and **Open Route in Maps** when both pins
exist. **View Full Map** opens a full-screen view with pickup, drop-off
and the driver's own vehicle position. Requests without pins show the
text locations and a "No map pin added" note — never a broken map. The
app never does turn-by-turn itself; navigation always opens Google/Apple
Maps. Each job in a multi-job queue keeps its own separate pins.

## Multi-job queues

One driver (and their vehicle) can carry **several active deliveries at
once**. The driver dashboard shows a numbered job queue with an
independent Start/Complete per job; manager vehicle cards show how many
active jobs each van carries; the assign panel lists busy
drivers/vehicles with their job counts so queuing another delivery is a
visible choice. A vehicle stays **busy until its last active job is
completed or cancelled** — enforced in the database, not the UI. When a
driver or manager stacks a job on someone with 3 or more active jobs, a
soft warning is shown; nothing is blocked.

## Vehicle service status

Beyond the automatic **available / busy / offline** states, a vehicle can
be flagged with a service condition: **maintenance**, **service due**,
**in service**, or **damaged**. The job→vehicle sync trigger never
overwrites these manual states, so a flag is not lost when the van takes
a job. **Maintenance, in service, and damaged** vehicles are hidden from
the manager's dispatch (assign) picker; **service due** is advisory only
— the vehicle stays dispatchable and is shown with an amber badge (and a
"service due" note in the picker). The manager Vehicle Status overview
badges and counts every state.

**Who can change it** (company-scoped throughout — no one can touch
another company's vehicles):

- **Company admin** and **manager** can set any of the six states. The
  admin uses the Vehicles section; the manager has a status control on
  each Vehicle Status card. Taking a *busy* vehicle out of service asks
  for confirmation first.
- **Drivers** can only *report a problem* on their own linked vehicle
  from the driver dashboard — **Mark Service Due** or **Report Damaged /
  Problem**, with an optional short note (e.g. "Tyre issue"). A driver
  cannot set available/offline/maintenance/in service, cannot touch
  another vehicle, and cannot clear a reported issue — only a
  manager/admin can. These limits are enforced by RLS and a database
  guard trigger, not just the UI. Outlet users have no service controls
  at all.

The latest reported note shows on the manager and admin vehicle cards;
returning a vehicle to **available/offline** clears it.

## KM / odometer tracking

Each job can capture odometer readings. The driver enters **Start KM**
when starting a trip and **End KM** when completing it (both optional — a
job still completes with no KM). **Total KM** is derived as end − start
and shown wherever the job appears. When End KM is entered, the vehicle's
**current_km** rolls forward to it (never backward, so a completed trip
advances the odometer and a stray low reading can't reduce it).

Enforced server-side (Migration 19), not just the UI: KM must be
non-negative and End KM cannot be below Start KM; a driver can only
enter/edit KM on their **own active** job, never on a closed one — after
that only a manager/admin can correct it (from the Active Jobs card), and
an admin can set a vehicle's odometer directly in the Vehicles section.
Managers/admins see KM on active jobs, job history and vehicle cards.
**Outlet users never see KM.**

## Fuel / gas logs

Vehicles have an **append-only** fuel log (`fuel_logs`): each fill-up
records liters, optional cost, an optional note, the date/time, who
entered it, and optional driver/job links. **Managers and admins** add
and view fuel entries from a vehicle's **⛽ Fuel** panel, which shows
recent entries and **today's total liters and cost** (totals are computed
on read, never stored — ready for the Stage 3D daily report).

**Drivers** can log fuel only for their **own linked vehicle**, and only
when an admin has switched it on (Admin → Company Settings →
*Allow drivers to log fuel*). The switch defaults **off**, and the gate
is enforced by row-level security — not just by hiding the form. Fuel
logs are never edited or deleted (a correction is a new entry), company
data never crosses companies, and **outlet users have no fuel access**.

## Reports (daily / date-range analytics)

**Company admins and managers** get a **📈 Reports** section on their
dashboard. Drivers and outlet users have no Reports section at all. It
calls one company-scoped, staff-guarded database function
(`company_report`) and shows, for a chosen range:

- **Presets** — Today (the default), Yesterday, Last 7 Days, This Month,
  or a **Custom** from/to range (max 366 days). A one-year range is never
  loaded automatically.
- **Filters** — by **vehicle** and by **driver**. A separate **Recent
  Jobs Status** filter narrows only the recent-jobs list, never the
  totals (a fuel-only entry has no job status, so a single status would
  make the other counts misleading).
- **For the selected range** — requests created, accepted, completed,
  cancelled, **Completion rate (of closed jobs)**, total KM, fuel litres
  and cost, and average delivery / request→accept / accepted→start times.
- **Right now** — a clearly separate current snapshot: pending and active
  jobs, drivers on duty, and a live count of every vehicle status.
- **Per-vehicle and per-driver** tables, plus a **Recent jobs** table.

Date boundaries are computed in the **company's timezone** in the
database, so "Today" is correct regardless of the viewer's device.
Missing rates and averages show as **—**. Inactive drivers/vehicles still
appear when they had activity in the range (flagged *inactive*). Wide
tables scroll sideways inside their own container so the page stays
mobile-friendly.

## Dispatch selection

Requests can go to **any available driver** (open dispatch, the
default: every on-duty driver in the company sees it, first to accept
wins) or to **one specific driver** (only that driver sees and can
accept it — even while off duty). The picker lists come from a
column-safe database function that exposes only driver name, duty
status and van — an outlet still cannot read phone numbers or license
details, and never sees another company.

Managers can also **create a manual request** from any pickup/drop-off
place — with optional map pins — without an outlet attached. Such
requests show as "🧑‍💼 Manager request" and are invisible to outlet
accounts. Manager assignment on pending cards remains the override
path.

## Driver duty status

Drivers go **On Duty / Off Duty** from their dashboard. Going on duty
starts location sharing (with the driver's permission) so idle on-duty
vans appear on the manager map; going off duty stops it. Existing
drivers were set on duty when the feature shipped; newly created drivers
start off duty. As everywhere else in the app, location only flows while
the driver keeps the app open — duty status does not enable background
tracking.

**Self-accept guardrails (enforced by RLS, not just the UI).** A driver
can see and accept a pending request only when **all** hold: they are
**on duty**, they have a **linked vehicle**, and that vehicle is
**active** with a **dispatchable** status (`available` or `busy`). This
applies to *both* open and targeted requests — off duty means no
self-accept at all (managers/admins can still assign). A driver also
**cannot go on duty without a linked vehicle**. Any not-dispatchable
state — `offline`, `maintenance`, `in_service`, `damaged`, or
`service_due` — blocks new self-accepts; in particular a driver-reported
issue immediately stops that van taking more jobs, while its existing
accepted/in-progress jobs continue and can be completed. Once flagged, a
vehicle can't be re-reported until a manager/admin clears it back to a
dispatchable status.

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
