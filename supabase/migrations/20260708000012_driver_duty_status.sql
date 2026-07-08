-- ============================================================
-- Fleet Board Pro — Migration 12 (Stage 2B-1): driver duty status
-- Run AFTER the earlier migrations.
--
-- Adds On Duty / Off Duty for drivers:
--
-- 1) drivers.on_duty + on_duty_since. New drivers start OFF duty;
--    existing active drivers are backfilled to ON duty so open
--    dispatch does not stop the moment this migration runs.
--
-- 2) A driver may flip their OWN duty flag — and nothing else. A
--    column-guard trigger (same pattern as protect_request_fields)
--    blocks a non-admin from touching name/phone/license/active/
--    company, so the new update policy only really grants the toggle.
--
-- 3) OPEN dispatch now requires the driver to be on duty: the two
--    dispatch policies from migration 9 are recreated with the
--    on-duty condition. Requests TARGETED at a specific driver stay
--    visible/acceptable regardless of duty — a manager chose that
--    person deliberately. Since Realtime delivery follows these same
--    SELECT policies, off-duty drivers also stop receiving
--    open-request notifications automatically.
--
-- No column is removed, company separation is untouched, and no
-- service_role is involved anywhere.
-- ============================================================

-- ---- 1) Duty columns ----
alter table public.drivers
  add column on_duty boolean not null default false,
  add column on_duty_since timestamptz;

-- Existing active drivers keep dispatch flowing (owner's decision):
update public.drivers set on_duty = true, on_duty_since = now() where active;

create index drivers_company_duty_idx on public.drivers (company_id, on_duty);

-- ---- Helper: is the calling driver on duty? ----
create or replace function app.i_am_on_duty()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select on_duty from public.drivers where id = app.my_driver_id()),
    false);
$$;

grant execute on function app.i_am_on_duty() to authenticated;

-- ---- 2) Driver flips own duty flag (and nothing else) ----
create or replace function app.protect_driver_fields()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null or app.is_admin() then
    return new;
  end if;
  if new.company_id       is distinct from old.company_id
     or new.name           is distinct from old.name
     or new.phone          is distinct from old.phone
     or new.license_number is distinct from old.license_number
     or new.active         is distinct from old.active then
    raise exception 'Only an admin can change driver details';
  end if;
  return new;
end;
$$;

create trigger drivers_protect_fields
  before update on public.drivers
  for each row execute function app.protect_driver_fields();

create policy drivers_update_self_duty on public.drivers
  for update to authenticated
  using (id = app.my_driver_id())
  with check (id = app.my_driver_id());

-- ---- 3) Open dispatch requires being on duty ----
drop policy requests_select_driver_dispatch on public.vehicle_requests;
create policy requests_select_driver_dispatch on public.vehicle_requests
  for select to authenticated
  using (
    status = 'pending'
    and company_id = app.my_company_id()
    and app.my_role() = 'driver'
    and (
      (dispatch_mode = 'open' and app.i_am_on_duty())
      or target_driver_id = app.my_driver_id()
    )
  );

drop policy requests_driver_accept on public.vehicle_requests;
create policy requests_driver_accept on public.vehicle_requests
  for update to authenticated
  using (
    status = 'pending'
    and company_id = app.my_company_id()
    and app.my_role() = 'driver'
    and (
      (dispatch_mode = 'open' and app.i_am_on_duty())
      or target_driver_id = app.my_driver_id()
    )
  )
  with check (
    driver_id = app.my_driver_id()
    and status = 'accepted'
  );
