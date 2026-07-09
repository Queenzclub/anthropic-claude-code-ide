-- ============================================================
-- Fleet Board Pro — Migration 15 (Stage 3A): vehicle service status
-- Run AFTER Migration 14.
--
-- Adds three service states to the vehicle_status enum so staff can flag
-- vehicles:
--   service_due — advisory; the vehicle is STILL dispatchable (amber badge).
--   in_service  — in the workshop; NOT dispatchable.
--   damaged     — out of action; NOT dispatchable.
--
-- Rule: the job->vehicle sync trigger only manages available<->busy. It
-- must NEVER overwrite a manual state (maintenance/service_due/in_service/
-- damaged), so a flag is not silently lost when the van takes a job and an
-- accidental assignment can't clobber it.
--
-- No column is dropped, company separation is untouched, job dispatch is
-- unchanged, and no service_role is used.
--
-- NOTE: Postgres will not let a brand-new enum value be USED in the same
-- transaction that adds it. The ALTER TYPE statements below each commit on
-- their own (autocommit / separate execution) before the function that
-- references them is (re)created.
-- ============================================================

-- ---- Add the enum values ----
alter type public.vehicle_status add value if not exists 'service_due';
alter type public.vehicle_status add value if not exists 'in_service';
alter type public.vehicle_status add value if not exists 'damaged';

-- ---- Preserve manual states in the job->vehicle sync trigger ----
-- Only change vs migration 1: the busy-set now skips every manual state,
-- not just 'maintenance'. release_vehicle is unchanged (it only ever
-- touches status = 'busy'), so flagged vehicles are never auto-released.
create or replace function app.sync_vehicle_status()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  -- Vehicle swapped or unassigned mid-job: free the old vehicle.
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
