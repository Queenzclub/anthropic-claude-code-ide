// Fleet Board Pro — Supabase configuration (Queenz Club production).
//
// These are PUBLIC values and are safe to commit / ship to browsers:
// the anon key only works through Row Level Security, which restricts
// every query to the caller's own company and role. This is the key
// Supabase exposes for client-side use.
//
// NEVER put the service_role key here — that one bypasses RLS.
//
// To point at a different project, edit these two values (or set the
// SUPABASE_URL / SUPABASE_ANON_KEY secrets, which the deploy workflow
// will use to overwrite this file at build time).

window.FLEET_CONFIG = {
  SUPABASE_URL: 'https://lvoyptbcdoedznkacuhf.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx2b3lwdGJjZG9lZHpua2FjdWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyNDc0NDMsImV4cCI6MjA5ODgyMzQ0M30.hr4FYexGOVhmJvXQdnSYPYVN35t72Ux06ydCgk_dcnU',
};
