-- ============================================================
-- Fleet Board Pro — Migration 5: vehicle status safety
-- Run AFTER the first four migrations.
--
-- Why: admins/managers can edit vehicle status from the dashboard,
-- but a vehicle that still has an active (accepted/in_progress) job
-- must not be flipped back to 'available' — that would allow
-- double-booking. The job workflow is unaffected: when a job is
-- completed or cancelled its row leaves the active statuses BEFORE
-- the sync trigger releases the vehicle, so the release passes this
-- check. Service-role/SQL-editor sessions pass through.
-- ============================================================

create or replace function app.protect_vehicle_status()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.status = 'available' and new.status is distinct from old.status then
    if exists (
      select 1 from public.vehicle_requests r
      where r.vehicle_id = new.id
        and r.status in ('accepted', 'in_progress')
    ) then
      raise exception 'Vehicle has an active job and cannot be set to available';
    end if;
  end if;

  return new;
end;
$$;

create trigger vehicles_protect_status
  before update on public.vehicles
  for each row execute function app.protect_vehicle_status();
