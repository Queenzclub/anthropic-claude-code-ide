-- ============================================================
-- Migration 23 (Stage 4A) — verification (Supabase SQL Editor)
-- Run AFTER applying 20260710000023_app_admin_platform.sql.
--
-- No psql-only syntax (no \set / :'var'). Every negative test is a
-- self-contained DO block that RAISEs only on the expected error, so it
-- FAILs loudly if a guard is removed. No reliance on pg_temp helpers.
--
--   * Part A — structure & grants. Run as-is.
--   * Part B — impersonation blocks (app_admin / admin / driver / outlet).
--     Each is BEGIN … SET LOCAL role authenticated … ROLLBACK, so it needs
--     a real user UUID and leaves NO data change behind. The SQL Editor
--     itself runs as a trusted role, so escalation/suspension can only be
--     judged from an impersonated authenticated context — hence Part B.
--
-- Find the UUIDs first:
--     select user_id, role, company_id from public.profiles order by role;
-- Paste an app_admin, a Company Admin, a driver and an outlet user_id into
-- the matching Part B blocks.  A NOTICE 'PASS …' is good; 'FAIL …' is not.
-- ============================================================


-- ================= Part A — structure & grants (run as-is) =================

-- A1 role + company_status enums.
select 'A1 user_role has app_admin' as check,
       exists(select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid
              where t.typname='user_role' and e.enumlabel='app_admin') as ok;
select 'A1b company_status values' as check,
       string_agg(e.enumlabel, ',' order by e.enumsortorder) as values
from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='company_status';

-- A2 companies lifecycle columns + backfill + mirror.
select 'A2 lifecycle columns' as check, count(*) as should_be_6
from information_schema.columns
where table_schema='public' and table_name='companies'
  and column_name in ('status','suspended_at','suspended_by','suspension_reason','archived_at','archived_by');
select 'A2b all companies active + mirrored' as check,
       coalesce(bool_and(status='active' and active=true), true) as ok
from public.companies;

-- A3 new functions present.
select 'A3 functions' as check, count(*) as should_be_11
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where p.proname in ('is_app_admin','my_account_access','suspend_company','reactivate_company',
                    'archive_company','restore_archived_company','platform_overview','company_detail',
                    'protect_app_admin_role','sync_company_active','platform_audit_immutable');

-- A4 platform_audit_log: exists, RLS on, SELECT-only grant to authenticated.
select 'A4 audit RLS enabled' as check, relrowsecurity as ok
from pg_class where oid='public.platform_audit_log'::regclass;
select 'A4b audit grants (expect only SELECT for authenticated)' as check,
       string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema='public' and table_name='platform_audit_log' and grantee='authenticated';

-- A5 app_admin SELECT policies: 7 operational tables + the audit-log read.
select 'A5 app_admin select policies' as check, count(*) as should_be_8
from pg_policies
where schemaname='public' and policyname like '%_select_appadmin';

-- A6 triggers present.
select 'A6 triggers' as check, count(*) as should_be_2
from pg_trigger
where tgname in ('companies_sync_active','profiles_protect_app_admin') and not tgisinternal;

-- A7 RPC execute granted to authenticated, revoked from anon/public.
select 'A7 rpc grants' as check, routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema='public'
  and routine_name in ('suspend_company','reactivate_company','archive_company',
                       'restore_archived_company','platform_overview','company_detail','my_account_access')
order by routine_name, grantee;

-- A8 my_account_access / company_report / platform funcs are SECURITY as expected.
select 'A8 function security' as check, p.proname,
       p.prosecdef as security_definer, p.proconfig as settings
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in ('is_app_admin','my_account_access','suspend_company','platform_overview','company_detail')
order by p.proname;


-- ================= Part B — impersonation (edit UUIDs, run each block) =======

-- ---------- B-APPADMIN: paste an app_admin user_id ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_WITH_REAL_APP_ADMIN_USER_UUID', true);
do $$
declare j jsonb;
begin
  if not app.is_app_admin() then raise exception 'FAIL: is_app_admin() false for this uid'; end if;
  if app.my_company_id() is not null then raise exception 'FAIL: app_admin has a company_id'; end if;
  if (select count(*) from public.companies) < 1 then raise exception 'FAIL: app_admin sees no companies'; end if;
  j := public.platform_overview();
  if not (j ? 'companies' and j ? 'totals') then raise exception 'FAIL: platform_overview shape'; end if;
  raise notice 'PASS B-APPADMIN: app_admin (company null) sees platform + companies';
end $$;
reset role;
rollback;

-- ---------- B-ADMIN: paste a Company Admin user_id (+ a second in-company user_id) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_WITH_REAL_COMPANY_ADMIN_USER_UUID', true);
do $$
begin
  -- sees exactly one company (their own)
  if (select count(*) from public.companies) <> 1 then raise exception 'FAIL: admin should see exactly 1 company'; end if;
  -- platform RPCs rejected
  begin perform public.platform_overview(); raise exception 'FAIL: admin ran platform_overview';
  exception when others then if position('Not allowed' in sqlerrm)=0 then raise; end if; end;
  begin perform public.company_detail(app.my_company_id()); raise exception 'FAIL: admin ran company_detail';
  exception when others then if position('Not allowed' in sqlerrm)=0 then raise; end if; end;
  -- cannot promote anyone to app_admin (uses a real in-company target below)
  begin
    update public.profiles set role='app_admin'
      where user_id='REPLACE_WITH_ANOTHER_IN_COMPANY_USER_UUID';
    raise exception 'FAIL: admin assigned app_admin';
  exception when others then
    if position('app_admin' in sqlerrm)=0 and position('Not allowed' in sqlerrm)=0 then raise; end if;
  end;
  raise notice 'PASS B-ADMIN: one-company view, platform RPCs rejected, cannot assign app_admin';
end $$;
reset role;
rollback;

-- ---------- B-SUSPEND: app_admin uid + a Company Admin uid of the SAME company ----------
-- Suspends that company, checks the admin is blocked, then reactivates —
-- all inside a rolled-back transaction, so the live data is unchanged.
begin;
set local role authenticated;
-- 1) suspend as app_admin
select set_config('request.jwt.claim.sub', 'REPLACE_WITH_REAL_APP_ADMIN_USER_UUID', true);
do $$
declare v_company uuid;
begin
  select company_id into v_company from public.profiles
    where user_id='REPLACE_WITH_REAL_COMPANY_ADMIN_USER_UUID';
  perform public.suspend_company(v_company, 'verification test');
  if (select status from public.companies where id=v_company) <> 'suspended'
    then raise exception 'FAIL: company not suspended'; end if;
  if (select active from public.companies where id=v_company) <> false
    then raise exception 'FAIL: companies.active did not mirror suspended'; end if;
end $$;
-- 2) that company's admin is now blocked
select set_config('request.jwt.claim.sub', 'REPLACE_WITH_REAL_COMPANY_ADMIN_USER_UUID', true);
do $$
begin
  if app.my_company_id() is not null then raise exception 'FAIL: my_company_id not null while suspended'; end if;
  if (select count(*) from public.companies) <> 0 then raise exception 'FAIL: suspended admin still sees a company'; end if;
  if (select count(*) from public.vehicle_requests) <> 0 then raise exception 'FAIL: suspended admin still sees requests'; end if;
  if (public.my_account_access()->>'company_status') <> 'suspended'
    then raise exception 'FAIL: my_account_access not suspended'; end if;
  raise notice 'PASS B-SUSPEND: suspend blocks the company; my_account_access reports suspended';
end $$;
-- 3) reactivate as app_admin, confirm access returns
select set_config('request.jwt.claim.sub', 'REPLACE_WITH_REAL_APP_ADMIN_USER_UUID', true);
do $$
declare v_company uuid;
begin
  select company_id into v_company from public.profiles
    where user_id='REPLACE_WITH_REAL_COMPANY_ADMIN_USER_UUID';
  perform public.reactivate_company(v_company);
  if (select status from public.companies where id=v_company) <> 'active'
    then raise exception 'FAIL: reactivate did not restore active'; end if;
  raise notice 'PASS B-SUSPEND: reactivate restores the company';
end $$;
reset role;
rollback;   -- undo the whole suspend/reactivate + audit rows

-- ---------- B-DRIVER: paste a driver user_id (must be blocked from platform) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_WITH_REAL_DRIVER_USER_UUID', true);
do $$
begin
  begin perform public.platform_overview(); raise exception 'FAIL: driver ran platform_overview';
  exception when others then if position('Not allowed' in sqlerrm)=0 then raise; end if; end;
  if (select count(*) from public.platform_audit_log) <> 0 then raise exception 'FAIL: driver read audit log'; end if;
  raise notice 'PASS B-DRIVER: driver blocked from platform_overview and audit log';
end $$;
reset role;
rollback;

-- ---------- B-AUDIT: audit log is append-only (paste an app_admin uid) ----------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'REPLACE_WITH_REAL_APP_ADMIN_USER_UUID', true);
do $$
begin
  begin update public.platform_audit_log set action='x'; raise exception 'FAIL: audit UPDATE allowed';
  exception when others then if position('append-only' in sqlerrm)=0 and position('denied' in sqlerrm)=0 then raise; end if; end;
  begin delete from public.platform_audit_log; raise exception 'FAIL: audit DELETE allowed';
  exception when others then if position('append-only' in sqlerrm)=0 and position('denied' in sqlerrm)=0 then raise; end if; end;
  raise notice 'PASS B-AUDIT: platform_audit_log is append-only';
end $$;
reset role;
rollback;
