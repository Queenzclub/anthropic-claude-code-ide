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

select 'A3 functions present' as check, count(*) as should_be_11
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where p.proname in ('is_app_admin','my_account_access','suspend_company','reactivate_company',
                    'archive_company','restore_archived_company','platform_overview','company_detail',
                    'protect_app_admin_role','sync_company_active','platform_audit_immutable');

select 'A3b locked search_path (expect {search_path=pg_catalog})' as check, p.proname, p.proconfig
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where p.proname in ('my_company_id','my_driver_id','my_outlet_id','my_vehicle_id','is_app_admin',
                    'protect_app_admin_role','suspend_company','platform_overview','company_detail','my_account_access')
order by p.proname;

select 'A4 audit RLS enabled' as check, relrowsecurity as ok
from pg_class where oid='public.platform_audit_log'::regclass;
select 'A4b audit grants for authenticated (expect only SELECT)' as check,
       string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema='public' and table_name='platform_audit_log' and grantee='authenticated';

select 'A5 app_admin select policies (7 tables + audit)' as check, count(*) as should_be_8
from pg_policies where schemaname='public' and policyname like '%_select_appadmin';

select 'A6 triggers' as check, count(*) as should_be_2
from pg_trigger where tgname in ('companies_sync_active','profiles_protect_app_admin') and not tgisinternal;

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
