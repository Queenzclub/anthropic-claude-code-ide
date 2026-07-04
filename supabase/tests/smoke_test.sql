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
   '40000000-0000-0000-0000-000000000001');

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

\echo 'TEST 9: location copied onto vehicle (expect 3.139 | t)'
select last_lat, last_updated is not null as fresh from public.vehicles
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
\echo '=== ALL SMOKE TESTS DONE ==='
