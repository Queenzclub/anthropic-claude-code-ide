# Fleet Board Pro

Vehicle location, delivery request, and fleet status management web app
for shop/company operations. Plain HTML/CSS/JS frontend with Supabase
(PostgreSQL + Auth + Row Level Security) as the backend.

## Project structure

```
index.html            Login page
admin.html            Admin dashboard
manager.html          Manager dashboard
outlet.html           Outlet staff dashboard
driver.html           Driver dashboard
css/style.css         Shared styles
js/config.example.js  Supabase config template (copy to js/config.js)
js/supabase-client.js Shared Supabase client (anon key only)
js/auth.js            Session/profile checks, role guard, logout
js/login.js           Login page logic
vendor/supabase.js    Vendored supabase-js library (no CDN needed)
supabase/             Database schema, RLS policies, setup guide
```

## Setup

1. **Database** — follow `supabase/README.md`: run the two migration
   files in the Supabase SQL Editor, create your company, and promote
   the first admin.
2. **Frontend config** — copy `js/config.example.js` to `js/config.js`
   and fill in your project URL and **anon** key (Supabase Dashboard →
   Project Settings → API). Never use the service_role key here.
3. **Serve the files** — any static host works. Locally:

   ```bash
   python3 -m http.server 8000
   ```

   then open http://localhost:8000

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
