-- ============================================================
-- Fleet Board Pro — Migration 6: pin search_path on set_updated_at
-- Addresses the Supabase security advisor warning
-- (function_search_path_mutable). The function references no
-- tables, so this is purely hardening.
-- Already applied to the production project via MCP on 2026-07-05.
-- ============================================================

alter function app.set_updated_at() set search_path = public;
