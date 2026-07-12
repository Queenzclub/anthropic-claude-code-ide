-- ============================================================
-- Migration 23 (Stage 4A) — verification (Supabase SQL Editor)
-- Run AFTER applying 20260710000023_app_admin_platform.sql.
--
-- No psql-only syntax (no \set / :'var'). Every negative test is a
-- self-contained DO block that RAISEs only on the EXPECTED failure, so it
-- FAILs loudly if a protected operation unexpectedly succeeds. No reliance
-- on pg_temp helpers surviving across runs.
--
--   * Part A — structure & grants. Run as-is (as the postgres SQL-Editor role).
--   * Part B — impersonation blocks. Each is BEGIN … SET LOCAL role
--     authenticated … ROLLBACK, so it needs real user UUIDs and leaves NO
--     data change. Confirm your editor role first:
--         select current_user, session_user;    -- expect: postgres | postgres
--     Find UUIDs:
--         select user_id, role, company_id from public.profiles order by role;
--     Pick an app_admin, a Company Admin, a Manager, a Driver and an Outlet
--     — the Admin/Manager/Driver/Outlet SHOULD be the SAME company for the
--     suspension block to be meaningful.
--   * A NOTICE 'PASS …' is good; 'FAIL …' or any ERROR is not.
-- ============================================================


-- ================= Part A — structure & grants (run as-is) =================

select 'A1 user_role has app_admin' as check,
       exists(select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid
              where t.typname='user_role' and e.enumlabel='app_admin') as ok;
select 'A1b company_status values (pending_setup,active,suspended,archived)' as check,
       string_agg(e.enumlabel, ',' order by e.enumsortorder) as values
from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='company_status';

select 'A2 lifecycle columns' as check, count(*) as should_be_6
from information_schema.columns
where table_schema='public' and table_name='companies'
  and column_name in ('status','suspended_at','suspended_by','suspension_reason','archived_at','archived_by');
select 'A2b all companies active + active mirrors status' as check,
       coalesce(bool_and(status='active' and active=true), true) as ok
from public.companies;

select 'A3 functions present' as check, count(*) as should_be_12
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where p.proname in ('is_app_admin','my_account_access','suspend_company','reactivate_company',
                    'archive_company','restore_archived_company','platform_overview','company_detail',
                    'protect_app_admin_role','sync_company_active','platform_audit_immutable',
                    'protect_company_lifecycle_fields');

select 'A3b locked search_path (expect {search_path=pg_catalog})' as check, p.proname, p.proconfig
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where p.proname in ('my_company_id','my_driver_id','my_outlet_id','my_vehicle_id','is_app_admin',
                    'protect_app_admin_role','protect_company_lifecycle_fields','suspend_company',
                    'platform_overview','company_detail','my_account_access')
order by p.proname;

select 'A4 audit RLS enabled' as check, relrowsecurity as ok
from pg_class where oid='public.platform_audit_log'::regclass;
select 'A4b audit grants for authenticated (expect only SELECT)' as check,
       string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema='public' and table_name='platform_audit_log' and grantee='authenticated';

select 'A5 app_admin select policies (7 tables + audit)' as check, count(*) as should_be_8
from pg_policies where schemaname='public' and policyname like '%_select_appadmin';

select 'A6 triggers' as check, count(*) as should_be_3
from pg_trigger where tgname in ('companies_sync_active','profiles_protect_app_admin',
                                 'companies_protect_lifecycle') and not tgisinternal;

-- BEFORE UPDATE triggers on companies fire in alphabetical name order, so the
-- lifecycle guard (companies_protect_lifecycle) runs BEFORE the active mirror
-- (companies_sync_active); it evaluates the caller's raw intent and cannot be
-- bypassed by the mirror. Expect, in order:
--   companies_protect_lifecycle, companies_sync_active, companies_updated_at,
--   companies_validate_timezone
select 'A6b companies BEFORE UPDATE trigger order' as check,
       string_agg(tgname, ', ' order by tgname) as fire_order
from pg_trigger
where tgrelid='public.companies'::regclass and not tgisinternal
  and (tgtype & 16) <> 0    -- UPDATE
  and (tgtype & 2)  <> 0;   -- BEFORE

select 'A7 rpc grants (authenticated only, no anon/public)' as check, routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema='public'
  and routine_name in ('suspend_company','reactivate_company','archive_company',
                       'restore_archived_company','platform_overview','company_detail','my_account_access')
order by routine_name, grantee;


-- ================= Part B — impersonation (edit UUIDs) =====================

-- ---------- B-APPADMIN: paste an app_admin user_id ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
do $$
declare j jsonb;
begin
  if not app.is_app_admin() then raise exception 'FAIL: is_app_admin() false'; end if;
  if app.my_company_id() is not null then raise exception 'FAIL: app_admin has a company_id'; end if;
  if (select count(*) from public.companies) < 1 then raise exception 'FAIL: app_admin sees no companies'; end if;
  j := public.platform_overview();
  if not (j->'companies' ? 'total' and j->'companies' ? 'non_archived' and j->'totals' ? 'drivers')
    then raise exception 'FAIL: platform_overview shape'; end if;
  -- company_detail returns all five arrays
  j := public.company_detail((select id from public.companies limit 1));
  if not (j ? 'company_admins' and j ? 'managers' and j ? 'drivers' and j ? 'outlets' and j ? 'vehicles' and j ? 'counts')
    then raise exception 'FAIL: company_detail missing arrays'; end if;
  -- app_admin has NO operational write access
  begin
    insert into public.vehicle_requests(company_id,outlet_id,status,pickup_location,dropoff_location,requested_by)
      values((select id from public.companies limit 1),(select id from public.outlets limit 1),'pending','P','D',auth.uid());
    raise exception 'FAIL: app_admin inserted a request';
  exception when others then if position('row-level security' in sqlerrm)=0 then raise; end if; end;
  raise notice 'PASS B-APPADMIN: company-null, platform read works, 5 detail arrays, no operational writes';
end $$;
reset role; rollback;

-- ---------- B-ADMIN: Company Admin uid + ANOTHER in-company user uid ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_COMPANY_ADMIN_UUID', true);
do $$
begin
  if (select count(*) from public.companies) <> 1 then raise exception 'FAIL: admin should see exactly 1 company'; end if;
  begin perform public.platform_overview(); raise exception 'FAIL: admin ran platform_overview';
  exception when others then if position('Not allowed' in sqlerrm)=0 then raise; end if; end;
  begin perform public.company_detail(app.my_company_id()); raise exception 'FAIL: admin ran company_detail';
  exception when others then if position('Not allowed' in sqlerrm)=0 then raise; end if; end;
  begin perform public.suspend_company(app.my_company_id(),'x'); raise exception 'FAIL: admin ran suspend_company';
  exception when others then if position('Not allowed' in sqlerrm)=0 then raise; end if; end;
  begin perform public.archive_company(app.my_company_id(),'x'); raise exception 'FAIL: admin ran archive_company';
  exception when others then if position('Not allowed' in sqlerrm)=0 then raise; end if; end;
  -- cannot assign app_admin to another in-company user
  begin
    update public.profiles set role='app_admin' where user_id='REPLACE_ANOTHER_IN_COMPANY_UUID';
    raise exception 'FAIL: admin assigned app_admin';
  exception when others then if position('app_admin' in sqlerrm)=0 and position('Not allowed' in sqlerrm)=0 then raise; end if; end;
  raise notice 'PASS B-ADMIN: one company; platform+lifecycle RPCs rejected; cannot assign app_admin';
end $$;
reset role; rollback;

-- ---------- B-MANAGER: Manager uid ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_MANAGER_UUID', true);
do $$
begin
  begin perform public.platform_overview(); raise exception 'FAIL: manager ran platform_overview';
  exception when others then if position('Not allowed' in sqlerrm)=0 then raise; end if; end;
  begin perform public.company_detail(app.my_company_id()); raise exception 'FAIL: manager ran company_detail';
  exception when others then if position('Not allowed' in sqlerrm)=0 then raise; end if; end;
  begin perform public.reactivate_company(app.my_company_id()); raise exception 'FAIL: manager ran reactivate_company';
  exception when others then if position('Not allowed' in sqlerrm)=0 then raise; end if; end;
  raise notice 'PASS B-MANAGER: platform + lifecycle RPCs rejected';
end $$;
reset role; rollback;

-- ---------- B-DRIVER: Driver uid ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_DRIVER_UUID', true);
do $$
begin
  begin perform public.platform_overview(); raise exception 'FAIL: driver ran platform_overview';
  exception when others then if position('Not allowed' in sqlerrm)=0 then raise; end if; end;
  if (select count(*) from public.platform_audit_log) <> 0 then raise exception 'FAIL: driver read audit log'; end if;
  raise notice 'PASS B-DRIVER: platform_overview rejected; audit log not readable';
end $$;
reset role; rollback;

-- ---------- B-OUTLET: Outlet uid ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_OUTLET_UUID', true);
do $$
begin
  begin perform public.platform_overview(); raise exception 'FAIL: outlet ran platform_overview';
  exception when others then if position('Not allowed' in sqlerrm)=0 then raise; end if; end;
  begin perform public.company_detail(app.my_company_id()); raise exception 'FAIL: outlet ran company_detail';
  exception when others then if position('Not allowed' in sqlerrm)=0 then raise; end if; end;
  raise notice 'PASS B-OUTLET: platform + company_detail rejected';
end $$;
reset role; rollback;

-- ---------- B-APPADMIN-ROLE-GUARD: only postgres/postgres may change app_admin ----------
-- protect_app_admin_role() authorizes app_admin profile writes on the trusted
-- SQL-Editor / migration context ALONE (current_user=session_user='postgres').
-- is_app_admin() being true does NOT authorize — runtime app_admin grant/revoke
-- is reserved for a future protected RPC. These all roll back.

-- (a) the SQL Editor (postgres/postgres) CAN bootstrap an app_admin. We promote
-- an existing ordinary profile in a rolled-back tx — no data change persists.
begin;
do $$ begin   -- runs as the editor role: current_user=session_user=postgres
  update public.profiles
     set role='app_admin', company_id=null, driver_id=null, vehicle_id=null, outlet_id=null
   where user_id='REPLACE_DRIVER_UUID';
  if not (select role::text='app_admin' and company_id is null
            from public.profiles where user_id='REPLACE_DRIVER_UUID')
    then raise exception 'FAIL: postgres/postgres bootstrap did not promote'; end if;
  raise notice 'PASS B-APPADMIN-BOOTSTRAP: postgres/postgres can create an app_admin';
end $$;
rollback;

-- (b) service_role — even carrying an app_admin JWT subject — cannot assign OR
-- remove app_admin (this is exactly the path the old is_app_admin() branch let
-- through). service_role bypasses RLS and has table grants, so the trigger is
-- the only thing stopping it.
begin;
set local role service_role;
select set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
do $$
declare v_mgr_company uuid;
begin
  select company_id into v_mgr_company from public.profiles where user_id='REPLACE_MANAGER_UUID';
  begin
    update public.profiles set role='app_admin', company_id=null where user_id='REPLACE_MANAGER_UUID';
    raise exception 'FAIL: service_role assigned app_admin';
  exception when others then if position('app_admin profile' in sqlerrm)=0 then raise; end if; end;
  begin
    update public.profiles set role='manager', company_id=v_mgr_company where user_id='REPLACE_APP_ADMIN_UUID';
    raise exception 'FAIL: service_role removed app_admin';
  exception when others then if position('app_admin profile' in sqlerrm)=0 then raise; end if; end;
  raise notice 'PASS B-APPADMIN-SERVICE: service_role (even with app_admin JWT) cannot assign or remove app_admin';
end $$;
reset role; rollback;

-- (c) an AUTHENTICATED app_admin cannot edit even its OWN profile by direct DML
-- (profiles_update_own exposes the row, so the write reaches the trigger).
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
do $$ begin
  begin
    update public.profiles set name='Renamed' where user_id='REPLACE_APP_ADMIN_UUID';
    raise exception 'FAIL: authenticated app_admin edited its own profile';
  exception when others then if position('app_admin profile' in sqlerrm)=0 then raise; end if; end;
  raise notice 'PASS B-APPADMIN-SELF: authenticated app_admin cannot edit its own app_admin profile';
end $$;
reset role; rollback;

-- ---------- B-LIFECYCLE-ADMIN: Company Admin cannot touch lifecycle columns ----------
-- companies_admin_update lets a Company Admin update its OWN company row, so
-- without the guard trigger it could set status/active/etc. directly and skip
-- the RPCs, transition checks, required reasons and audit. Every direct
-- lifecycle write must raise; legitimate settings (timezone,
-- allow_driver_fuel_entry) must still succeed. Rolled back — nothing persists.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_COMPANY_ADMIN_UUID', true);
do $$
declare v_company uuid; col text; n int;
begin
  v_company := app.my_company_id();
  if v_company is null then raise exception 'FAIL: admin has no company (bad UUID?)'; end if;
  -- every lifecycle column, one at a time, must be rejected by the trigger
  begin update public.companies set status='suspended' where id=v_company;
    raise exception 'FAIL: admin set status directly';
  exception when others then if position('lifecycle fields' in sqlerrm)=0 then raise; end if; end;
  begin update public.companies set status='archived' where id=v_company;
    raise exception 'FAIL: admin archived directly';
  exception when others then if position('lifecycle fields' in sqlerrm)=0 then raise; end if; end;
  begin update public.companies set active=false where id=v_company;
    raise exception 'FAIL: admin flipped active directly';
  exception when others then if position('lifecycle fields' in sqlerrm)=0 then raise; end if; end;
  begin update public.companies set suspended_at=now() where id=v_company;
    raise exception 'FAIL: admin set suspended_at directly';
  exception when others then if position('lifecycle fields' in sqlerrm)=0 then raise; end if; end;
  begin update public.companies set suspended_by=auth.uid() where id=v_company;
    raise exception 'FAIL: admin set suspended_by directly';
  exception when others then if position('lifecycle fields' in sqlerrm)=0 then raise; end if; end;
  begin update public.companies set suspension_reason='x' where id=v_company;
    raise exception 'FAIL: admin set suspension_reason directly';
  exception when others then if position('lifecycle fields' in sqlerrm)=0 then raise; end if; end;
  begin update public.companies set archived_at=now() where id=v_company;
    raise exception 'FAIL: admin set archived_at directly';
  exception when others then if position('lifecycle fields' in sqlerrm)=0 then raise; end if; end;
  begin update public.companies set archived_by=auth.uid() where id=v_company;
    raise exception 'FAIL: admin set archived_by directly';
  exception when others then if position('lifecycle fields' in sqlerrm)=0 then raise; end if; end;
  -- the row must be untouched
  if (select status from public.companies where id=v_company) <> 'active'
    then raise exception 'FAIL: status mutated'; end if;
  -- legitimate settings still work
  update public.companies set timezone='UTC' where id=v_company; get diagnostics n=row_count;
  if n<>1 then raise exception 'FAIL: admin blocked from timezone (% rows)', n; end if;
  update public.companies set allow_driver_fuel_entry = not allow_driver_fuel_entry where id=v_company;
  get diagnostics n=row_count;
  if n<>1 then raise exception 'FAIL: admin blocked from allow_driver_fuel_entry (% rows)', n; end if;
  raise notice 'PASS B-LIFECYCLE-ADMIN: all lifecycle columns rejected; timezone + allow_driver_fuel_entry still editable';
end $$;
reset role; rollback;

-- ---------- B-LIFECYCLE-OTHERS: Manager/Driver/Outlet/app_admin direct lifecycle ----------
-- These roles have no companies UPDATE policy, so RLS filters the row out
-- (0 rows) — the lifecycle change never lands. Verified per role.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_MANAGER_UUID', true);
do $$ declare n int; begin
  update public.companies set status='suspended';   -- unqualified: only rows RLS exposes
  get diagnostics n=row_count;
  if n<>0 then raise exception 'FAIL: manager changed % company rows', n; end if;
end $$;
select set_config('request.jwt.claim.sub', 'REPLACE_DRIVER_UUID', true);
do $$ declare n int; begin
  update public.companies set active=false; get diagnostics n=row_count;
  if n<>0 then raise exception 'FAIL: driver changed % company rows', n; end if;
end $$;
select set_config('request.jwt.claim.sub', 'REPLACE_OUTLET_UUID', true);
do $$ declare n int; begin
  update public.companies set archived_at=now(); get diagnostics n=row_count;
  if n<>0 then raise exception 'FAIL: outlet changed % company rows', n; end if;
end $$;
select set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
do $$ declare n int; begin
  -- app_admin gets SELECT on every company but NO update policy, so a direct
  -- write is filtered to 0 rows: lifecycle changes are RPC-only for app_admin.
  update public.companies set status='suspended'; get diagnostics n=row_count;
  if n<>0 then raise exception 'FAIL: app_admin changed % company rows directly', n; end if;
  raise notice 'PASS B-LIFECYCLE-OTHERS: manager/driver/outlet/app_admin direct lifecycle writes hit 0 rows (RPC-only)';
end $$;
reset role; rollback;

-- ---------- B-LIFECYCLE-SERVICE: service_role is the case the trigger exists for ----------
-- service_role bypasses RLS AND has table grants, so ONLY the trigger stands
-- between it and a direct lifecycle write. It must be rejected — even if the
-- caller flips the RPC marker on, because v_rpc also requires
-- current_user='postgres', which a direct service_role write never has.
-- Non-lifecycle settings remain writable. Rolled back.
begin;
set local role service_role;
do $$ begin
  update public.companies set status='suspended', active=false, suspended_at=now(), suspension_reason='sr';
  raise exception 'FAIL: service_role changed lifecycle directly';
exception when others then if position('lifecycle fields' in sqlerrm)=0 then raise; end if; end $$;
select set_config('app.lifecycle_rpc','on',true);   -- marker alone must not be enough
do $$ begin
  update public.companies set status='suspended';
  raise exception 'FAIL: marker alone let service_role through';
exception when others then if position('lifecycle fields' in sqlerrm)=0 then raise; end if; end $$;
select set_config('app.lifecycle_rpc','off',true);
do $$ declare n int; begin
  update public.companies set timezone='UTC'; get diagnostics n=row_count;   -- non-lifecycle: allowed
  if n<1 then raise exception 'FAIL: service_role blocked from a non-lifecycle settings write'; end if;
  raise notice 'PASS B-LIFECYCLE-SERVICE: service_role direct lifecycle rejected by trigger (marker alone insufficient); settings still writable';
end $$;
reset role; rollback;

-- ---------- B-SUSPEND-CYCLE: app_admin uid + SAME-company Admin/Manager/Driver/Outlet uids ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
do $$
declare v_company uuid;
begin
  select company_id into v_company from public.profiles where user_id='REPLACE_COMPANY_ADMIN_UUID';
  perform public.suspend_company(v_company, 'verification');
  if (select status from public.companies where id=v_company) <> 'suspended' then raise exception 'FAIL: not suspended'; end if;
  if (select active from public.companies where id=v_company) <> false then raise exception 'FAIL: active not mirrored'; end if;
  -- transition guards
  begin perform public.suspend_company(v_company,'x'); raise exception 'FAIL: re-suspend allowed';
  exception when others then if position('active company can be suspended' in sqlerrm)=0 then raise; end if; end;
end $$;
-- each ordinary role of that company is blocked while suspended
select set_config('request.jwt.claim.sub', 'REPLACE_COMPANY_ADMIN_UUID', true);
do $$ begin
  if app.my_company_id() is not null then raise exception 'FAIL: admin my_company_id not null'; end if;
  if (select count(*) from public.companies)<>0 then raise exception 'FAIL: admin sees company'; end if;
  if (public.my_account_access()->>'company_status')<>'suspended' then raise exception 'FAIL: my_account_access not suspended'; end if;
end $$;
select set_config('request.jwt.claim.sub', 'REPLACE_MANAGER_UUID', true);
do $$ begin
  begin perform public.company_report(current_date,current_date); raise exception 'FAIL: manager report while suspended';
  exception when others then if position('Not allowed' in sqlerrm)=0 then raise; end if; end;
  if (select count(*) from public.vehicle_requests)<>0 then raise exception 'FAIL: manager sees requests'; end if;
end $$;
select set_config('request.jwt.claim.sub', 'REPLACE_DRIVER_UUID', true);
do $$ declare n int; begin
  update public.drivers set on_duty = not on_duty where id = app.my_driver_id(); get diagnostics n=row_count;
  if n<>0 then raise exception 'FAIL: driver changed duty while suspended'; end if;
  if (select count(*) from public.vehicles)<>0 then raise exception 'FAIL: driver sees vehicles'; end if;
end $$;
select set_config('request.jwt.claim.sub', 'REPLACE_OUTLET_UUID', true);
do $$ begin
  if (select count(*) from public.vehicle_requests)<>0 then raise exception 'FAIL: outlet sees requests'; end if;
end $$;
-- reactivate; transition guard: reactivate only from suspended
select set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
do $$
declare v_company uuid;
begin
  select company_id into v_company from public.profiles where user_id='REPLACE_COMPANY_ADMIN_UUID';
  perform public.reactivate_company(v_company);
  if (select status from public.companies where id=v_company)<>'active' then raise exception 'FAIL: not reactivated'; end if;
  begin perform public.reactivate_company(v_company); raise exception 'FAIL: reactivate active allowed';
  exception when others then if position('suspended company can be reactivated' in sqlerrm)=0 then raise; end if; end;
  raise notice 'PASS B-SUSPEND-CYCLE: suspend blocks Admin/Manager/Driver/Outlet + reports/duty; reactivate restores; transitions enforced';
end $$;
reset role; rollback;

-- ---------- B-ARCHIVE: app_admin uid + a Company Admin uid ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
do $$
declare v_company uuid; j jsonb;
begin
  select company_id into v_company from public.profiles where user_id='REPLACE_COMPANY_ADMIN_UUID';
  perform public.archive_company(v_company, 'verification');
  if (select status from public.companies where id=v_company)<>'archived' then raise exception 'FAIL: not archived'; end if;
  -- hidden from default overview, shown with include_archived
  j := public.platform_overview();
  if (j->'company_list') @> jsonb_build_array(jsonb_build_object('id', v_company)) then raise exception 'FAIL: archived shown by default'; end if;
  if (j->'companies'->>'total')::int < 1 then raise exception 'FAIL: total should include archived'; end if;
  j := public.platform_overview(true);
  if not (j->'company_list') @> jsonb_build_array(jsonb_build_object('id', v_company)) then raise exception 'FAIL: include_archived did not show it'; end if;
  -- re-archive rejected; restore only from archived
  begin perform public.archive_company(v_company,'x'); raise exception 'FAIL: re-archive allowed';
  exception when others then if position('can be archived' in sqlerrm)=0 then raise; end if; end;
  perform public.restore_archived_company(v_company);
  if (select status from public.companies where id=v_company)<>'active' then raise exception 'FAIL: restore failed'; end if;
  begin perform public.restore_archived_company(v_company); raise exception 'FAIL: restore active allowed';
  exception when others then if position('archived company can be restored' in sqlerrm)=0 then raise; end if; end;
  raise notice 'PASS B-ARCHIVE: archive blocks + hides from default, include_archived shows, restore works, transitions enforced';
end $$;
reset role; rollback;

-- ---------- B-ARCHIVE-FROM-SUSPENDED: restore clears stale suspension metadata ----------
-- A company can be archived from suspended. Restoring it must yield a fully
-- clean active row — suspension metadata cleared too, not just archive fields.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
do $$
declare v_company uuid;
begin
  select company_id into v_company from public.profiles where user_id='REPLACE_COMPANY_ADMIN_UUID';
  perform public.suspend_company(v_company, 'susp-before-archive');
  perform public.archive_company(v_company, 'arch-from-suspended');
  -- archive itself does NOT clear suspension metadata (it is carried into archived)
  if (select suspension_reason from public.companies where id=v_company) is distinct from 'susp-before-archive'
    then raise exception 'FAIL: suspension metadata lost before restore'; end if;
  perform public.restore_archived_company(v_company);
  if not (select status='active' and active=true
            and suspended_at is null and suspended_by is null and suspension_reason is null
            and archived_at is null and archived_by is null
          from public.companies where id=v_company)
    then raise exception 'FAIL: restore left stale metadata: %',
      (select row(status,active,suspended_at,suspended_by,suspension_reason,archived_at,archived_by)
         from public.companies where id=v_company); end if;
  -- history preserved in the audit log
  if not exists (select 1 from public.platform_audit_log where target_company_id=v_company
                   and action='company_suspended' and details->>'reason'='susp-before-archive')
     or not exists (select 1 from public.platform_audit_log where target_company_id=v_company
                   and action='company_archived' and details->>'prev_status'='suspended')
     or not exists (select 1 from public.platform_audit_log where target_company_id=v_company
                   and action='company_restored' and details->>'prev_status'='archived')
    then raise exception 'FAIL: audit trail incomplete for suspend->archive->restore'; end if;
  raise notice 'PASS B-ARCHIVE-FROM-SUSPENDED: restore clears suspension+archive metadata; audit preserves prev statuses+reason';
end $$;
reset role; rollback;

-- ---------- B-PENDING: app_admin uid + a Company Admin uid (postgres sets pending_setup) ----------
-- app_admin has no companies UPDATE path, so pending_setup is set directly
-- (this simulates the Stage 4B create flow) inside a rolled-back transaction.
begin;
-- as postgres: put that admin's company into pending_setup
update public.companies set status='pending_setup'
  where id = (select company_id from public.profiles where user_id='REPLACE_COMPANY_ADMIN_UUID');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_COMPANY_ADMIN_UUID', true);
do $$ begin
  if app.my_company_id() is not null then raise exception 'FAIL: pending_setup admin has company access'; end if;
  if (select count(*) from public.companies)<>0 then raise exception 'FAIL: pending_setup admin sees company'; end if;
end $$;
select set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
do $$
declare v_company uuid;
begin
  select id into v_company from public.companies
    where id = (select company_id from public.profiles where user_id='REPLACE_COMPANY_ADMIN_UUID');
  begin perform public.reactivate_company(v_company); raise exception 'FAIL: reactivated pending_setup';
  exception when others then if position('suspended company can be reactivated' in sqlerrm)=0 then raise; end if; end;
  raise notice 'PASS B-PENDING: pending_setup blocks the company and cannot be activated via reactivate_company';
end $$;
reset role; rollback;

-- ---------- B-AUDIT: app_admin uid ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_APP_ADMIN_UUID', true);
do $$
begin
  -- append-only
  begin update public.platform_audit_log set action='x'; raise exception 'FAIL: audit UPDATE allowed';
  exception when others then if position('append-only' in sqlerrm)=0 and position('denied' in sqlerrm)=0 then raise; end if; end;
  begin delete from public.platform_audit_log; raise exception 'FAIL: audit DELETE allowed';
  exception when others then if position('append-only' in sqlerrm)=0 and position('denied' in sqlerrm)=0 then raise; end if; end;
  raise notice 'PASS B-AUDIT: platform_audit_log is append-only (lifecycle rows carry actor/target/action/prev_status by construction)';
end $$;
reset role; rollback;
