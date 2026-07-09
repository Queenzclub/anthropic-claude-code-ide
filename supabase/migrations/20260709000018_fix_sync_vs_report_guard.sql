-- ============================================================
-- Fleet Board Pro — Migration 18 (fix): job-driven vehicle sync must
-- bypass the driver-report guard
-- Run AFTER Migration 17.
--
-- Regression from Migration 16/17. app.protect_vehicle_driver_report is a
-- BEFORE UPDATE trigger on vehicles that treats ANY driver-context status
-- change as a "report" and rejects anything other than service_due /
-- damaged. But app.sync_vehicle_status (the AFTER trigger on
-- vehicle_requests) releases the vehicle busy -> available in the SAME
-- driver transaction when the driver completes their LAST active job — so
-- the guard rejects that automatic 'available' and the whole completion
-- aborts. The same applies to the busy-set on a driver self-accept
-- (available -> busy). When another active job remains, release_vehicle
-- doesn't touch the vehicle, so completion slips through — the reported
-- "accept another job first" workaround.
--
-- Fix: sync_vehicle_status marks its job-driven vehicle writes with a
-- transaction-local GUC, and the driver-report guard skips them. Direct
-- driver reports (which do NOT go through the sync trigger) are still
-- fully guarded; protect_vehicle_status still prevents freeing a vehicle
-- that has another active job; RLS is untouched; no service_role is used.
-- ============================================================

create or replace function app.sync_vehicle_status()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  -- These vehicle writes are driven by job state, not a driver edit —
  -- flag them so the driver-report guard lets them through.
  perform set_config('app.fbp_sync', 'on', true);

  if tg_op = 'UPDATE'
     and old.vehicle_id is not null
     and old.vehicle_id is distinct from new.vehicle_id then
    perform app.release_vehicle(old.vehicle_id, new.id);
  end if;

  if new.vehicle_id is not null then
    if new.status in ('accepted', 'in_progress') then
      update public.vehicles
      set status = 'busy'
      where id = new.vehicle_id
        and status not in ('maintenance', 'service_due', 'in_service', 'damaged');
    elsif new.status in ('completed', 'cancelled') then
      perform app.release_vehicle(new.vehicle_id, new.id);
    end if;
  end if;

  return new;
end;
$$;

create or replace function app.protect_vehicle_driver_report()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  -- Job-driven sync (accept / complete / cancel) is a system action, not a
  -- driver report — never guard it.
  if current_setting('app.fbp_sync', true) = 'on' then
    return new;
  end if;

  if auth.uid() is null or app.is_staff() then
    return new;
  end if;

  if app.my_role() = 'driver' then
    if new.company_id     is distinct from old.company_id
       or new.vehicle_name is distinct from old.vehicle_name
       or new.plate_number is distinct from old.plate_number
       or new.driver_id    is distinct from old.driver_id
       or new.active       is distinct from old.active then
      raise exception 'Drivers can only report a vehicle issue';
    end if;

    if old.status in ('service_due', 'damaged', 'maintenance', 'in_service')
       and (new.status is distinct from old.status
            or new.service_note is distinct from old.service_note) then
      raise exception 'This vehicle already has an open issue. Manager or admin must clear it first';
    end if;

    if new.status is distinct from old.status
       and new.status not in ('service_due', 'damaged') then
      raise exception 'Drivers can only mark a vehicle Service Due or Damaged';
    end if;
  end if;

  return new;
end;
$$;
