# Fleet Board Pro — Supabase Setup

This folder contains the database schema and security policies.

## How to apply

Open your Supabase project → **SQL Editor**, then run the two files in order:

1. `migrations/20260704000001_initial_schema.sql` — tables, enums, triggers
2. `migrations/20260704000002_rls_policies.sql` — Row Level Security

(If you use the Supabase CLI instead, `supabase db push` picks them up from
`supabase/migrations/` automatically.)

## One-time setup after the migrations

New signups get an **inactive profile with no company** — they can see nothing
until an admin sets them up. So the very first company and admin must be
created manually in the SQL Editor:

### 1. Create your company

```sql
insert into public.companies (name, code)
values ('My Company', 'GLOW2026');
```

### 2. Create the first admin

Sign up a user through Supabase Auth (Dashboard → Authentication → Add user,
or the app's login page later). Then promote them:

```sql
update public.profiles
set company_id = (select id from public.companies where code = 'GLOW2026'),
    role       = 'admin',
    active     = true
where email = 'admin@example.com';
```

From then on, that admin can activate other users and assign their role,
outlet, or driver record from inside the app (or the SQL editor until the
admin UI exists).

### 3. Typical setup for other users

```sql
-- Outlet staff: link to an outlet
update public.profiles
set company_id = (select id from public.companies where code = 'GLOW2026'),
    role       = 'outlet',
    outlet_id  = '<outlet uuid>',
    active     = true
where email = 'shop@example.com';

-- Driver: link to a driver record
update public.profiles
set company_id = (select id from public.companies where code = 'GLOW2026'),
    role       = 'driver',
    driver_id  = '<driver uuid>',
    active     = true
where email = 'driver@example.com';
```

## Testing the schema locally

`tests/smoke_test.sql` verifies the whole security model on a throwaway
local Postgres (company isolation, role access, status transitions, vehicle
sync, location privacy). It is **not** meant for a real Supabase project.

```bash
createdb fleettest
psql -d fleettest -f supabase/tests/local_shim.sql \
     -f supabase/migrations/20260704000001_initial_schema.sql \
     -f supabase/migrations/20260704000002_rls_policies.sql \
     -f supabase/tests/smoke_test.sql
```

All checks print `PASS` or an expected count. Re-run it after any change
to the schema or policies.

## Keys

- The frontend must only ever use the **anon (public) key**.
- The **service_role key** must never appear in HTML, JS, or this repository.
  It is only for the Supabase dashboard and trusted server-side tools.

## How the security model works

- Every table carries `company_id`; every policy checks it against the
  caller's own company. Company A can never read Company B.
- Roles: `admin`, `manager`, `outlet`, `driver` (stored on `profiles.role`,
  changeable only by an admin — enforced by a database trigger, not just UI).
- Inactive profiles match no policy, so a fresh signup has zero access.
- Logged-out (anon) clients have no table access at all.
- Drivers can only update their own location and their own assigned jobs.
- Outlet staff can only see their own outlet's requests, and cannot read
  vehicle locations or the driver list.

## Vehicle status is automatic

Database triggers keep `vehicles.status` correct:

- Job **accepted** or **in_progress** → vehicle becomes `busy`
- Job **completed** or **cancelled** → vehicle returns to `available`
  (only if it has no other active job, and never while in `maintenance`)
- Location updates refresh `last_lat` / `last_lng` / `last_updated`;
  the UI shows a vehicle as **offline** when `last_updated` is too old.

Two partial unique indexes enforce the core business rules:
one active job per vehicle, one active job per driver.

## Job status flow

```
pending → accepted → in_progress → completed
        ↘ cancelled  ↘ cancelled   ↘ cancelled
```

A database trigger rejects invalid transitions and stamps
`accepted_at` / `started_at` / `completed_at` / `cancelled_at`
automatically. Only admin/manager can modify a closed job (mistake fixing).
