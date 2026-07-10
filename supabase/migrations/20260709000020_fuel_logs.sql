-- ============================================================
-- Fleet Board Pro — Migration 20 (Stage 3C): fuel / gas logs
-- Run AFTER Migration 19.
--
-- Adds append-only fuel logging per vehicle:
--   * public.fuel_logs — one row per fill-up (liters, cost, note, time),
--     optionally linked to a driver and a job. Append-only: there are no
--     update/delete policies, so history is never rewritten (a correction
--     is a new entry).
--   * companies.allow_driver_fuel_entry — company switch (default OFF) that
--     gates whether drivers may log fuel. Enforced in RLS, not just the UI.
--
-- Access model (company-scoped throughout, no service_role):
--   * Manager/Admin add and view their company's fuel logs.
--   * A driver may log fuel ONLY for their own linked vehicle, and ONLY
--     when their company has enabled it; a driver sees their own entries.
--   * Outlet users have no fuel-log access at all.
--
-- No triggers on vehicles/vehicle_requests — the KM, dispatch, location
-- and status flows are completely untouched.
-- ============================================================

-- ---- Company switch (off by default) ----
alter table public.companies
  add column if not exists allow_driver_fuel_entry boolean not null default false;

-- ---- Fuel logs (append-only) ----
create table if not exists public.fuel_logs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id),
  vehicle_id  uuid not null references public.vehicles (id),
  driver_id   uuid references public.drivers (id),           -- if available
  request_id  uuid references public.vehicle_requests (id),  -- if related to a job
  liters      numeric check (liters is null or liters >= 0), -- fuel amount
  cost        numeric check (cost   is null or cost   >= 0), -- optional
  note        text,
  filled_at   timestamptz not null default now(),
  created_by  uuid not null references public.profiles (user_id),
  created_at  timestamptz not null default now()
);

create index if not exists fuel_logs_company_idx on public.fuel_logs (company_id, filled_at desc);
create index if not exists fuel_logs_vehicle_idx on public.fuel_logs (vehicle_id, filled_at desc);

-- ---- Helper: does the caller's company allow driver fuel entry? ----
create or replace function app.company_allows_driver_fuel()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select allow_driver_fuel_entry from public.companies where id = app.my_company_id()),
    false);
$$;

grant execute on function app.company_allows_driver_fuel() to authenticated;

-- ---- Row Level Security ----
alter table public.fuel_logs enable row level security;
revoke all on public.fuel_logs from anon;

-- Select: staff see the whole company; a driver sees their own entries.
create policy fuel_select_staff on public.fuel_logs
  for select to authenticated
  using (app.is_staff() and company_id = app.my_company_id());

create policy fuel_select_own_driver on public.fuel_logs
  for select to authenticated
  using (driver_id = app.my_driver_id());

-- Insert (staff): any company vehicle; driver/job links (if set) must be
-- in-company too.
create policy fuel_insert_staff on public.fuel_logs
  for insert to authenticated
  with check (
    app.is_staff()
    and company_id = app.my_company_id()
    and created_by = auth.uid()
    and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.company_id = app.my_company_id())
    and (driver_id  is null or exists (select 1 from public.drivers d where d.id = driver_id and d.company_id = app.my_company_id()))
    and (request_id is null or exists (select 1 from public.vehicle_requests r where r.id = request_id and r.company_id = app.my_company_id()))
  );

-- Insert (driver): only their OWN linked vehicle, only when the company
-- switch is on. driver_id is pinned to themselves.
create policy fuel_insert_driver on public.fuel_logs
  for insert to authenticated
  with check (
    app.my_role() = 'driver'
    and app.company_allows_driver_fuel()
    and company_id = app.my_company_id()
    and created_by = auth.uid()
    and driver_id  = app.my_driver_id()
    and vehicle_id = app.my_vehicle_id()
    and (request_id is null or exists (select 1 from public.vehicle_requests r where r.id = request_id and r.company_id = app.my_company_id()))
  );

-- No update / delete policies: fuel_logs is append-only.
