-- ============================================================
-- Fleet Board Pro — Migration 11: reliable vehicle on driver-accept
-- Run AFTER the earlier migrations.
--
-- Problem: when a driver accepts an OPEN request (no manager
-- assignment), the outlet could not track the van because the accepted
-- request often had no vehicle_id. Manager assignment worked because the
-- manager picks the vehicle explicitly.
--
-- Two safe changes, no RLS weakening, no service_role, no new columns:
--
-- 1) app.my_vehicle_id() now resolves the driver's vehicle from EITHER
--    link the admin may have used: the driver user's default vehicle
--    (profiles.vehicle_id) OR the vehicle whose driver_id points at the
--    driver record. Whichever is set wins.
--
-- 2) On a driver self-accept (pending -> accepted, claiming the job for
--    themselves) with no vehicle chosen, the request's vehicle_id is
--    filled server-side from app.my_vehicle_id(). This makes tracking
--    work the same whether a manager assigned the job or the driver
--    accepted an open one — the client no longer has to send the vehicle.
--    If the driver genuinely has no vehicle linked, vehicle_id stays
--    null (the outlet then shows "Waiting for a vehicle to be assigned").
-- ============================================================

-- ---- 1) Resolve the driver's vehicle from either link ----
create or replace function app.my_vehicle_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    -- The driver user's own default vehicle, if the admin set one.
    (select p.vehicle_id from public.profiles p
      where p.user_id = auth.uid() and p.active),
    -- Otherwise the active vehicle whose driver_id is this driver record.
    (select v.id from public.vehicles v
      where v.driver_id = app.my_driver_id() and v.active
      order by v.created_at
      limit 1)
  );
$$;

grant execute on function app.my_vehicle_id() to authenticated;

-- ---- 2) Auto-assign the vehicle on driver self-accept ----
-- Same guard as before (assignment columns stay manager/admin only), but
-- now a driver claiming an unassigned job gets their vehicle filled in
-- automatically before the checks run, so the vehicle_id check passes.
create or replace function app.protect_request_fields()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null or app.is_staff() then
    return new;
  end if;

  -- Driver claiming this job for themselves: if they didn't send a
  -- vehicle, assign their own so the outlet can track the delivery.
  if old.driver_id is null
     and new.driver_id = app.my_driver_id()
     and new.vehicle_id is null then
    new.vehicle_id := app.my_vehicle_id();
  end if;

  if new.company_id      is distinct from old.company_id
     or new.outlet_id    is distinct from old.outlet_id
     or new.requested_by is distinct from old.requested_by then
    raise exception 'Only a manager or admin can change job assignment';
  end if;

  if new.driver_id is distinct from old.driver_id
     and not (old.driver_id is null and new.driver_id = app.my_driver_id()) then
    raise exception 'Only a manager or admin can change job assignment';
  end if;

  if new.vehicle_id is distinct from old.vehicle_id
     and not (old.vehicle_id is null and new.vehicle_id = app.my_vehicle_id()) then
    raise exception 'Only a manager or admin can change job assignment';
  end if;

  return new;
end;
$$;
