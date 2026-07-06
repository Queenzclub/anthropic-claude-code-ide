-- Smoke test for schema + RLS. Run on a LOCAL throwaway Postgres only
-- (after local_shim.sql and both migrations) - never on a real Supabase project.
-- Covers: signup trigger, company isolation, role access, status transitions,
-- vehicle busy/available sync, location privacy, anon lockout.
\set ON_ERROR_STOP on
\pset footer off

-- ============ Seed (as service role / SQL editor would) ============
insert into public.companies (id, name, code) values
  ('10000000-0000-0000-0000-000000000001', 'Glow Co',  'GLOW2026'),
  ('20000000-0000-0000-0000-000000000001', 'Other Co', 'OTHER01');

insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'admin@glow.test'),
  ('a0000000-0000-0000-0000-000000000002', 'manager@glow.test'),
  ('a0000000-0000-0000-0000-000000000003', 'shop@glow.test'),
  ('a0000000-0000-0000-0000-000000000004', 'driver@glow.test'),
  ('b0000000-0000-0000-0000-000000000001', 'admin@other.test'),
  ('c0000000-0000-0000-0000-000000000001', 'newsignup@glow.test');

insert into public.outlets (id, company_id, name) values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Main Shop');

insert into public.drivers (id, company_id, name) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Driver One'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Driver Two');

insert into public.vehicles (id, company_id, vehicle_name, plate_number, driver_id) values
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Van 1', 'ABC-123',
   '40000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Van 2', 'XYZ-789', null);

update public.profiles set company_id='10000000-0000-0000-0000-000000000001', role='admin',   active=true where user_id='a0000000-0000-0000-0000-000000000001';
update public.profiles set company_id='10000000-0000-0000-0000-000000000001', role='manager', active=true where user_id='a0000000-0000-0000-0000-000000000002';
update public.profiles set company_id='10000000-0000-0000-0000-000000000001', role='outlet',  outlet_id='30000000-0000-0000-0000-000000000001', active=true where user_id='a0000000-0000-0000-0000-000000000003';
update public.profiles set company_id='10000000-0000-0000-0000-000000000001', role='driver',  driver_id='40000000-0000-0000-0000-000000000001', active=true where user_id='a0000000-0000-0000-0000-000000000004';
update public.profiles set company_id='20000000-0000-0000-0000-000000000001', role='admin',   active=true where user_id='b0000000-0000-0000-0000-000000000001';

\echo 'TEST 0: signup trigger auto-created profiles (expect 6)'
select count(*) as profiles from public.profiles;

-- ============ Outlet staff session ============
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000003', false) \g /dev/null

\echo 'TEST 1: outlet creates a request (expect INSERT 0 1)'
insert into public.vehicle_requests (company_id, outlet_id, pickup_location, dropoff_location, customer_name, requested_by)
values ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
        'Main Shop', '12 Beach Rd', 'Mr Lee', 'a0000000-0000-0000-0000-000000000003');

\echo 'TEST 2: outlet sees own request (expect 1) but NO vehicles or locations (expect 0,0)'
select count(*) as my_requests from public.vehicle_requests;
select count(*) as vehicles_visible from public.vehicles;
select count(*) as locations_visible from public.location_updates;

-- ============ Manager session ============
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', false) \g /dev/null

\echo 'TEST 3: manager sees pending request, assigns driver+vehicle and accepts'
update public.vehicle_requests
set driver_id='40000000-0000-0000-0000-000000000001',
    vehicle_id='50000000-0000-0000-0000-000000000001',
    status='accepted'
where status='pending';

\echo 'TEST 4: vehicle auto became busy, accepted_at stamped (expect busy | t)'
select v.status, r.accepted_at is not null as stamped
from public.vehicles v join public.vehicle_requests r on r.vehicle_id = v.id;

\echo 'TEST 5: double-booking same vehicle rejected (expect PASS)'
do $$ begin
  insert into public.vehicle_requests (company_id, outlet_id, vehicle_id, status, pickup_location, dropoff_location, requested_by)
  values ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
          '50000000-0000-0000-0000-000000000001','accepted','A','B','a0000000-0000-0000-0000-000000000002');
  raise exception 'FAIL: double booking allowed';
exception when unique_violation then raise notice 'PASS: unique index blocked double booking';
end $$;

-- ============ Driver session ============
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000004', false) \g /dev/null

\echo 'TEST 6: driver sees own job (expect 1) and own vehicle (expect 1)'
select count(*) as my_jobs from public.vehicle_requests;
select count(*) as my_vehicle from public.vehicles;

\echo 'TEST 7: driver cannot skip accepted -> completed (expect PASS)'
do $$ begin
  update public.vehicle_requests set status='completed' where status='accepted';
  raise exception 'FAIL: invalid transition allowed';
exception when raise_exception then raise notice 'PASS: invalid transition blocked -> %', sqlerrm;
end $$;

\echo 'TEST 8: driver starts trip then updates location'
update public.vehicle_requests set status='in_progress' where status='accepted';
insert into public.location_updates (company_id, driver_id, vehicle_id, lat, lng)
values ('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',
        '50000000-0000-0000-0000-000000000001', 3.139, 101.6869);

\echo 'TEST 9: location copied onto vehicle, vehicle stays busy during trip (expect busy | 3.139 | t)'
select status, last_lat, last_updated is not null as fresh from public.vehicles
where id='50000000-0000-0000-0000-000000000001';

\echo 'TEST 10: driver cannot post location as another driver (expect PASS)'
do $$ begin
  insert into public.location_updates (company_id, driver_id, lat, lng)
  values ('10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000002', 1, 1);
  raise exception 'FAIL: spoofed location allowed';
exception when insufficient_privilege or check_violation then
  raise notice 'PASS: RLS blocked wrong-driver location';
end $$;

\echo 'TEST 11: driver cannot promote themselves (expect PASS)'
do $$ begin
  update public.profiles set role='admin' where user_id=auth.uid();
  raise exception 'FAIL: self-promotion allowed';
exception when raise_exception then raise notice 'PASS: role change blocked -> %', sqlerrm;
end $$;

\echo 'TEST 12: driver completes job -> vehicle available again (expect available | t)'
update public.vehicle_requests set status='completed' where status='in_progress';
select v.status, r.completed_at is not null as stamped
from public.vehicles v join public.vehicle_requests r on r.vehicle_id = v.id;

\echo 'TEST 13: closed job cannot be edited by driver (expect PASS)'
do $$ begin
  update public.vehicle_requests set status='in_progress' where status='completed';
  raise exception 'FAIL: reopened closed job';
exception when raise_exception then raise notice 'PASS: closed job locked -> %', sqlerrm;
end $$;

-- ============ Company B admin session ============
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-000000000001', false) \g /dev/null

\echo 'TEST 14: Company B admin sees NOTHING of Company A (expect 0,0,0,0)'
select count(*) as requests from public.vehicle_requests;
select count(*) as vehicles from public.vehicles;
select count(*) as drivers from public.drivers;
select count(*) as locations from public.location_updates;

-- ============ Fresh signup (inactive) session ============
select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000001', false) \g /dev/null

\echo 'TEST 15: inactive new signup sees nothing (expect 0 companies, 0 requests)'
select count(*) as companies from public.companies;
select count(*) as requests from public.vehicle_requests;

-- ============ Logged-out (anon) ============
reset role;
set role anon;
\echo 'TEST 16: anon has no table access (expect PASS)'
do $$ begin
  perform count(*) from public.vehicle_requests;
  raise exception 'FAIL: anon can read';
exception when insufficient_privilege then raise notice 'PASS: anon blocked';
end $$;

reset role;

-- ============ Driver sees the vehicle of their active job ============
\echo 'TEST 17: driver sees active-job vehicle even when not their default vehicle (expect 2)'
insert into public.vehicle_requests
  (company_id, outlet_id, driver_id, vehicle_id, status, pickup_location, dropoff_location, requested_by)
values
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
   '40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002',
   'accepted', 'Shop', 'Airport', 'a0000000-0000-0000-0000-000000000002');
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000004', false) \g /dev/null
select count(*) as visible_vehicles from public.vehicles;

\echo 'TEST 18: driver cannot change assignment fields on own job (expect PASS)'
do $$ begin
  update public.vehicle_requests
  set vehicle_id = '50000000-0000-0000-0000-000000000001'
  where status = 'accepted';
  raise exception 'FAIL: driver changed vehicle_id';
exception when raise_exception then
  raise notice 'PASS: assignment locked -> %', sqlerrm;
end $$;

\echo 'TEST 19: driver can still start and complete that job (expect in_progress then completed | available)'
update public.vehicle_requests set status = 'in_progress' where status = 'accepted';
select status from public.vehicle_requests where vehicle_id = '50000000-0000-0000-0000-000000000002';
update public.vehicle_requests set status = 'completed' where status = 'in_progress';

-- Vehicle check as superuser: after completion the driver correctly
-- loses visibility of that vehicle again (no more active job on it).
reset role;
select r.status, v.status as vehicle_status
from public.vehicle_requests r join public.vehicles v on v.id = r.vehicle_id
where r.vehicle_id = '50000000-0000-0000-0000-000000000002';

-- ============ Cross-company location protection ============
\echo 'TEST 20: driver cannot attach location to another company vehicle (expect PASS)'
insert into public.vehicles (id, company_id, vehicle_name, plate_number) values
  ('50000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-000000000001', 'B Van', 'BBB-111');
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000004', false) \g /dev/null
do $$ begin
  insert into public.location_updates (company_id, driver_id, vehicle_id, lat, lng)
  values ('10000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
          '50000000-0000-0000-0000-00000000000b', 1, 1);
  raise exception 'FAIL: cross-company vehicle location allowed';
exception when insufficient_privilege or check_violation then
  raise notice 'PASS: cross-company vehicle blocked';
end $$;
reset role;

-- ============ History visibility per role ============
-- Closed jobs so far: 2 completed for outlet 1 / driver 1. Add a second
-- outlet with a cancelled request (no driver) to test outlet separation.
\echo 'TEST 21: history — manager sees all company closed (3), outlet only own outlet (2), driver only own (2)'
insert into public.outlets (id, company_id, name) values
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Second Shop');
insert into public.vehicle_requests
  (company_id, outlet_id, status, pickup_location, dropoff_location, requested_by, cancellation_reason, cancelled_at)
values
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002',
   'cancelled', 'Second Shop', 'Old Town', 'a0000000-0000-0000-0000-000000000002', 'Customer called off', now());

set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', false) \g /dev/null
select count(*) as manager_sees from public.vehicle_requests where status in ('completed', 'cancelled');
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000003', false) \g /dev/null
select count(*) as outlet_sees from public.vehicle_requests where status in ('completed', 'cancelled');
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000004', false) \g /dev/null
select count(*) as driver_sees from public.vehicle_requests where status in ('completed', 'cancelled');
reset role;

-- ============ Admin management ============
-- Attach the fresh signup to the company first (the documented manual
-- step from supabase/README.md) so the admin can manage it.
-- Clear the lingering JWT claim so this runs as a true superuser step.
select set_config('request.jwt.claim.sub', '', false) \g /dev/null
update public.profiles set company_id = '10000000-0000-0000-0000-000000000001'
where user_id = 'c0000000-0000-0000-0000-000000000001';

set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', false) \g /dev/null

\echo 'TEST 22: admin creates outlet/driver/vehicle and manages a profile (expect INSERT x3 then 1 row x3)'
insert into public.outlets (company_id, name, address) values
  ('10000000-0000-0000-0000-000000000001', 'Admin Shop', '5 New St');
insert into public.drivers (company_id, name, phone) values
  ('10000000-0000-0000-0000-000000000001', 'Driver Three', '019-000');
insert into public.vehicles (company_id, vehicle_name, plate_number) values
  ('10000000-0000-0000-0000-000000000001', 'Van 5', 'NEW-555');
update public.profiles
set role = 'outlet', outlet_id = '30000000-0000-0000-0000-000000000001', active = true
where user_id = 'c0000000-0000-0000-0000-000000000001'
returning user_id;
update public.profiles set active = false
where user_id = 'c0000000-0000-0000-0000-000000000001'
returning user_id;
update public.outlets set phone = '03-123' where name = 'Admin Shop' returning id;

\echo 'TEST 23: admin cannot manage another company (expect 0 rows, PASS, 0 rows)'
update public.profiles set active = false
where user_id = 'b0000000-0000-0000-0000-000000000001'
returning user_id;
do $$ begin
  insert into public.outlets (company_id, name)
  values ('20000000-0000-0000-0000-000000000001', 'Intruder Outlet');
  raise exception 'FAIL: cross-company outlet insert allowed';
exception when insufficient_privilege or check_violation then
  raise notice 'PASS: cross-company outlet insert blocked';
end $$;
update public.vehicles set vehicle_name = 'Hacked'
where id = '50000000-0000-0000-0000-00000000000b'
returning id;

reset role;
-- Give veh1 an active job again to test the vehicle status guard.
insert into public.vehicle_requests
  (company_id, outlet_id, driver_id, vehicle_id, status, pickup_location, dropoff_location, requested_by)
values
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
   '40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001',
   'accepted', 'Shop', 'Docks', 'a0000000-0000-0000-0000-000000000002');
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', false) \g /dev/null

\echo 'TEST 24: vehicle with active job cannot be set available (expect PASS), maintenance still allowed (expect 1 row)'
do $$ begin
  update public.vehicles set status = 'available'
  where id = '50000000-0000-0000-0000-000000000001';
  raise exception 'FAIL: freed a vehicle with an active job';
exception when raise_exception then
  raise notice 'PASS: vehicle status guarded -> %', sqlerrm;
end $$;
update public.vehicles set status = 'maintenance'
where id = '50000000-0000-0000-0000-000000000001'
returning id;
reset role;

-- ============ Outlet tracks only its own active delivery ============
-- State here: vehicle 1 (50..001) has an accepted job for outlet 1
-- (the "Docks" job). Vehicle 2 (50..002) is idle. Add an active job
-- for the SECOND outlet on a fresh van, which outlet 1 must NOT see.
insert into public.drivers (id, company_id, name) values
  ('40000000-0000-0000-0000-0000000000d2', '10000000-0000-0000-0000-000000000001', 'Outlet2 Driver');
insert into public.vehicles (id, company_id, vehicle_name, plate_number) values
  ('50000000-0000-0000-0000-0000000000d2', '10000000-0000-0000-0000-000000000001', 'Outlet2 Van', 'O2-1');
insert into public.vehicle_requests
  (company_id, outlet_id, driver_id, vehicle_id, status, pickup_location, dropoff_location, requested_by)
values
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002',
   '40000000-0000-0000-0000-0000000000d2', '50000000-0000-0000-0000-0000000000d2',
   'accepted', 'Second Shop', 'Town', 'a0000000-0000-0000-0000-000000000002');

set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000003', false) \g /dev/null
\echo 'TEST 25: outlet sees its own active-delivery van (t), not an idle van (f), not another outlet''s van (f)'
select
  exists(select 1 from public.vehicles where id = '50000000-0000-0000-0000-000000000001') as sees_own_delivery,
  exists(select 1 from public.vehicles where id = '50000000-0000-0000-0000-000000000002') as sees_idle_van,
  exists(select 1 from public.vehicles where id = '50000000-0000-0000-0000-0000000000d2') as sees_other_outlet_van;
reset role;

\echo 'TEST 26: outlet loses tracking once its delivery closes (expect f)'
-- Clear the lingering JWT claim so this closes the job as a service step.
select set_config('request.jwt.claim.sub', '', false) \g /dev/null
update public.vehicle_requests set status = 'completed'
where vehicle_id = '50000000-0000-0000-0000-000000000001' and status = 'accepted';
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000003', false) \g /dev/null
select exists(select 1 from public.vehicles where id = '50000000-0000-0000-0000-000000000001') as still_sees_after_complete;
reset role;

\echo '=== ALL SMOKE TESTS DONE ==='
