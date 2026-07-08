-- ============================================================
-- Fleet Board Pro — Migration 13 (Stage 2B-2): dispatch selection
-- Run AFTER the earlier migrations.
--
-- Enables choosing WHO a request goes to:
--
-- 1) vehicle_requests.outlet_id becomes nullable so a manager can
--    create a manual request from any pickup/drop-off place. RLS
--    already handles it: outlets only see rows whose outlet_id equals
--    their own (so manager requests are invisible to outlets), staff
--    see all company rows, and drivers see it as a normal open or
--    targeted request. The outlet INSERT policy still requires
--    outlet_id = their own outlet, so outlets cannot create
--    outlet-less requests.
--
-- 2) public.dispatchable_drivers() — the column-safe way for the
--    request forms to list drivers. It returns ONLY id, name, duty
--    and van name/plate for ACTIVE drivers in the CALLER'S company.
--    No policy on the drivers table changes, so an outlet still
--    cannot read phone numbers or license numbers, and nothing is
--    ever visible across companies. (Lives in the public schema
--    because PostgREST only exposes functions there.)
--
-- 3) A safety net: a 'specific' request must actually have a target
--    driver. Any old row that says specific but has no target is
--    converted to 'open' first (it was undeliverable anyway), so the
--    constraint cannot fail while being added.
-- ============================================================

-- ---- 1) Manager manual requests: outlet becomes optional ----
alter table public.vehicle_requests
  alter column outlet_id drop not null;

-- ---- 2) Column-safe driver list for the dispatch pickers ----
create or replace function public.dispatchable_drivers()
returns table (
  driver_id    uuid,
  driver_name  text,
  on_duty      boolean,
  vehicle_id   uuid,
  vehicle_name text,
  plate_number text
)
language sql stable security definer
set search_path = public
as $$
  select d.id, d.name, d.on_duty, v.id, v.vehicle_name, v.plate_number
  from public.drivers d
  left join lateral (
    select id, vehicle_name, plate_number
    from public.vehicles
    where driver_id = d.id and active
    order by created_at
    limit 1
  ) v on true
  where d.company_id = app.my_company_id()
    and d.active
  order by d.name;
$$;

revoke all on function public.dispatchable_drivers() from public, anon;
grant execute on function public.dispatchable_drivers() to authenticated;

-- ---- 3) 'specific' must have a target driver ----
-- Repair first: any specific request without a target was reachable by
-- no driver; make it open so it can actually be picked up.
update public.vehicle_requests
set dispatch_mode = 'open'
where dispatch_mode = 'specific'
  and target_driver_id is null;

alter table public.vehicle_requests
  add constraint requests_specific_needs_target
  check (dispatch_mode <> 'specific' or target_driver_id is not null);
