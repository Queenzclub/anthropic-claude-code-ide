-- ============================================================
-- Fleet Board Pro — Migration 19 (Stage 3B): KM / odometer tracking
-- Run AFTER Migration 18.
--
-- Adds simple per-job odometer capture and a rolling vehicle odometer:
--   * vehicles.current_km      — latest known odometer for the vehicle.
--   * vehicle_requests.start_km / end_km — captured by the driver at
--     Start Trip / Complete Job (both optional; a job still completes
--     with no KM). total_km is derived (end_km - start_km), never stored.
--
-- Rules (enforced server-side, not just the UI):
--   * KM must be non-negative; end_km cannot be less than start_km.
--   * A driver may only set/change KM while the job is ACTIVE
--     (accepted/in_progress) and only on their own job (RLS scopes rows).
--     Once the job is closed, only a manager/admin can correct KM.
--   * When end_km is set, the vehicle's current_km moves UP to it (never
--     down) — a completed trip advances the odometer, a correction never
--     silently reduces it.
--
-- Company separation is unchanged, RLS is untouched, and no service_role
-- is used. The vehicle write is done by a SECURITY DEFINER trigger and is
-- flagged app.fbp_sync so the driver-report guard treats it as a system
-- action (see Migration 18).
-- ============================================================

-- ---- Columns ----
alter table public.vehicles add column if not exists current_km numeric;

alter table public.vehicle_requests
  add column if not exists start_km numeric,
  add column if not exists end_km   numeric;

-- ---- Validation: non-negative, ordered, and driver-only-while-active ----
create or replace function app.validate_job_km()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.start_km is not null and new.start_km < 0 then
    raise exception 'KM cannot be negative';
  end if;
  if new.end_km is not null and new.end_km < 0 then
    raise exception 'KM cannot be negative';
  end if;
  if new.start_km is not null and new.end_km is not null and new.end_km < new.start_km then
    raise exception 'End KM cannot be less than Start KM';
  end if;

  -- Drivers (non-staff) may only touch KM while the job is active. Judged
  -- by the OLD status, so entering end_km during the in_progress ->
  -- completed transition is allowed, but editing a closed job is not.
  -- Staff (manager/admin) can correct any time; SQL-editor sessions pass.
  if tg_op = 'UPDATE' and auth.uid() is not null and not app.is_staff() then
    if (new.start_km is distinct from old.start_km or new.end_km is distinct from old.end_km)
       and old.status not in ('accepted', 'in_progress') then
      raise exception 'KM can only be entered while the job is active';
    end if;
  end if;

  return new;
end;
$$;

create trigger requests_validate_km
  before insert or update on public.vehicle_requests
  for each row execute function app.validate_job_km();

-- ---- Roll the vehicle odometer forward when end_km is captured ----
create or replace function app.apply_job_km_to_vehicle()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.end_km is not null and new.vehicle_id is not null
     and (tg_op = 'INSERT' or new.end_km is distinct from old.end_km) then
    -- Job-driven vehicle write: flag it so the driver-report guard skips it.
    perform set_config('app.fbp_sync', 'on', true);
    update public.vehicles
    set current_km = new.end_km
    where id = new.vehicle_id
      and (current_km is null or new.end_km > current_km);
  end if;
  return new;
end;
$$;

create trigger requests_apply_km
  after insert or update on public.vehicle_requests
  for each row execute function app.apply_job_km_to_vehicle();
