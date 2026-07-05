-- ============================================================
-- Fleet Board Pro — Migration 2: Row Level Security
-- Run AFTER 20260704000001_initial_schema.sql.
--
-- Access model:
--   * Everything is scoped to the caller's company via
--     app.my_company_id(). Company A can never read Company B.
--   * Inactive users (and new signups) match no policy at all.
--   * anon (logged out) has no access to any table.
--   * Creating companies and the first admin is done from the
--     Supabase dashboard/SQL editor (service role) — never from
--     the frontend.
-- ============================================================

-- Defense in depth: logged-out clients get nothing.
revoke all on all tables in schema public from anon;

alter table public.companies        enable row level security;
alter table public.profiles         enable row level security;
alter table public.outlets          enable row level security;
alter table public.drivers          enable row level security;
alter table public.vehicles         enable row level security;
alter table public.vehicle_requests enable row level security;
alter table public.location_updates enable row level security;
alter table public.job_notes        enable row level security;
alter table public.delivery_proofs  enable row level security;

-- ------------------------------------------------------------
-- companies
-- Members can see their own company. Only an admin can edit it.
-- No insert/delete from clients: new companies are created via
-- the dashboard (service role).
-- ------------------------------------------------------------

create policy companies_select_own on public.companies
  for select to authenticated
  using (id = app.my_company_id());

create policy companies_admin_update on public.companies
  for update to authenticated
  using (app.is_admin() and id = app.my_company_id())
  with check (id = app.my_company_id());

-- ------------------------------------------------------------
-- profiles
-- Users see their own profile; admin/manager see company staff.
-- Users can update their own row (name/phone — the
-- protect_profile_fields trigger blocks role/company changes);
-- admins can update anyone in their company.
-- Inserts come from the signup trigger; no client insert.
-- No delete: deactivate instead (active = false).
-- ------------------------------------------------------------

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (user_id = auth.uid());

create policy profiles_select_company_staff on public.profiles
  for select to authenticated
  using (app.is_staff() and company_id = app.my_company_id());

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy profiles_admin_update on public.profiles
  for update to authenticated
  using (app.is_admin() and company_id = app.my_company_id())
  with check (company_id = app.my_company_id());

-- ------------------------------------------------------------
-- outlets
-- Any company member can see outlets (needed to show names on
-- requests). Only admins manage them.
-- ------------------------------------------------------------

create policy outlets_select_company on public.outlets
  for select to authenticated
  using (company_id = app.my_company_id());

create policy outlets_admin_insert on public.outlets
  for insert to authenticated
  with check (app.is_admin() and company_id = app.my_company_id());

create policy outlets_admin_update on public.outlets
  for update to authenticated
  using (app.is_admin() and company_id = app.my_company_id())
  with check (company_id = app.my_company_id());

-- ------------------------------------------------------------
-- drivers
-- Admin/manager see all company drivers; a driver sees their own
-- record. Only admins manage driver records.
-- Outlet staff cannot browse the driver list.
-- ------------------------------------------------------------

create policy drivers_select_staff on public.drivers
  for select to authenticated
  using (app.is_staff() and company_id = app.my_company_id());

create policy drivers_select_self on public.drivers
  for select to authenticated
  using (id = app.my_driver_id());

create policy drivers_admin_insert on public.drivers
  for insert to authenticated
  with check (app.is_admin() and company_id = app.my_company_id());

create policy drivers_admin_update on public.drivers
  for update to authenticated
  using (app.is_admin() and company_id = app.my_company_id())
  with check (company_id = app.my_company_id());

-- ------------------------------------------------------------
-- vehicles
-- Admin/manager see the fleet (including location). A driver
-- sees the vehicle assigned to them. Outlet staff get NO direct
-- vehicle access — this keeps driver locations private from
-- outlets, per CLAUDE.md. Status changes for jobs happen through
-- the sync trigger, so drivers never need update rights here.
-- Admins insert vehicles; admin/manager can update (e.g. set
-- maintenance, fix a stuck status).
-- ------------------------------------------------------------

create policy vehicles_select_staff on public.vehicles
  for select to authenticated
  using (app.is_staff() and company_id = app.my_company_id());

create policy vehicles_select_own_driver on public.vehicles
  for select to authenticated
  using (driver_id = app.my_driver_id());

create policy vehicles_admin_insert on public.vehicles
  for insert to authenticated
  with check (app.is_admin() and company_id = app.my_company_id());

create policy vehicles_staff_update on public.vehicles
  for update to authenticated
  using (app.is_staff() and company_id = app.my_company_id())
  with check (company_id = app.my_company_id());

-- ------------------------------------------------------------
-- vehicle_requests
-- Select: staff see all company requests; outlet staff see their
-- outlet's; drivers see jobs assigned to them.
-- Insert: outlet staff create pending requests for their own
-- outlet; staff can create requests for any company outlet.
-- Update: staff manage anything in-company; drivers update jobs
-- assigned to them (accept/start/complete — the status trigger
-- enforces valid transitions); outlet staff can edit or cancel
-- their own requests only while still pending.
-- No delete: history is kept, cancellation is a status.
-- ------------------------------------------------------------

create policy requests_select_staff on public.vehicle_requests
  for select to authenticated
  using (app.is_staff() and company_id = app.my_company_id());

create policy requests_select_outlet on public.vehicle_requests
  for select to authenticated
  using (outlet_id is not null and outlet_id = app.my_outlet_id());

create policy requests_select_driver on public.vehicle_requests
  for select to authenticated
  using (driver_id is not null and driver_id = app.my_driver_id());

create policy requests_insert_outlet on public.vehicle_requests
  for insert to authenticated
  with check (
    app.my_role() = 'outlet'
    and company_id = app.my_company_id()
    and outlet_id = app.my_outlet_id()
    and requested_by = auth.uid()
    and status = 'pending'
  );

create policy requests_insert_staff on public.vehicle_requests
  for insert to authenticated
  with check (
    app.is_staff()
    and company_id = app.my_company_id()
    and requested_by = auth.uid()
  );

create policy requests_update_staff on public.vehicle_requests
  for update to authenticated
  using (app.is_staff() and company_id = app.my_company_id())
  with check (company_id = app.my_company_id());

create policy requests_update_driver on public.vehicle_requests
  for update to authenticated
  using (driver_id = app.my_driver_id())
  with check (driver_id = app.my_driver_id());

create policy requests_update_outlet_pending on public.vehicle_requests
  for update to authenticated
  using (
    app.my_role() = 'outlet'
    and outlet_id = app.my_outlet_id()
    and status = 'pending'
  )
  with check (
    outlet_id = app.my_outlet_id()
    and status in ('pending', 'cancelled')
  );

-- ------------------------------------------------------------
-- location_updates
-- A driver may only insert their OWN location, for a vehicle in
-- their own company. Admin/manager can view all company
-- locations; a driver can view their own history. Outlet staff
-- see no locations.
-- ------------------------------------------------------------

create policy locations_insert_own_driver on public.location_updates
  for insert to authenticated
  with check (
    driver_id = app.my_driver_id()
    and company_id = app.my_company_id()
    and (
      vehicle_id is null
      or exists (
        select 1 from public.vehicles v
        where v.id = vehicle_id and v.company_id = app.my_company_id()
      )
    )
  );

create policy locations_select_staff on public.location_updates
  for select to authenticated
  using (app.is_staff() and company_id = app.my_company_id());

create policy locations_select_own_driver on public.location_updates
  for select to authenticated
  using (driver_id = app.my_driver_id());

-- ------------------------------------------------------------
-- job_notes
-- If you can see the request (per the request policies above),
-- you can read its notes and add your own.
-- ------------------------------------------------------------

create policy job_notes_select on public.job_notes
  for select to authenticated
  using (
    exists (select 1 from public.vehicle_requests r where r.id = request_id)
  );

create policy job_notes_insert on public.job_notes
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and company_id = app.my_company_id()
    and exists (select 1 from public.vehicle_requests r where r.id = request_id)
  );

-- ------------------------------------------------------------
-- delivery_proofs
-- The assigned driver uploads proof for their own job; anyone
-- who can see the request can view its proofs.
-- ------------------------------------------------------------

create policy delivery_proofs_select on public.delivery_proofs
  for select to authenticated
  using (
    exists (select 1 from public.vehicle_requests r where r.id = request_id)
  );

create policy delivery_proofs_insert_driver on public.delivery_proofs
  for insert to authenticated
  with check (
    driver_id = app.my_driver_id()
    and company_id = app.my_company_id()
    and exists (
      select 1 from public.vehicle_requests r
      where r.id = request_id and r.driver_id = app.my_driver_id()
    )
  );

-- ------------------------------------------------------------
-- Realtime: let dashboards subscribe to changes. RLS still
-- applies to realtime — users only receive rows they can select.
-- ------------------------------------------------------------

alter publication supabase_realtime add table public.vehicle_requests;
alter publication supabase_realtime add table public.vehicles;
alter publication supabase_realtime add table public.location_updates;
