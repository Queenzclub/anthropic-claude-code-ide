-- ============================================================
-- Fleet Board Pro — Migration 4: lock job assignment fields
-- Run AFTER the first three migrations.
--
-- Why: RLS already restricts WHICH request rows an outlet or
-- driver user may update, and the status trigger validates
-- transitions — but a driver could still modify columns like
-- vehicle_id or outlet_id on their own job. This trigger keeps
-- ownership/assignment columns manager/admin-only. Status
-- updates (start trip, complete job) are unaffected.
-- Service-role/SQL-editor sessions (no auth.uid) pass through.
-- ============================================================

create or replace function app.protect_request_fields()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null or app.is_staff() then
    return new;
  end if;

  if new.company_id      is distinct from old.company_id
     or new.outlet_id    is distinct from old.outlet_id
     or new.driver_id    is distinct from old.driver_id
     or new.vehicle_id   is distinct from old.vehicle_id
     or new.requested_by is distinct from old.requested_by then
    raise exception 'Only a manager or admin can change job assignment';
  end if;

  return new;
end;
$$;

create trigger requests_protect_fields
  before update on public.vehicle_requests
  for each row execute function app.protect_request_fields();
