// Creates the shared Supabase client (anon key only — see js/config.example.js).
// Exposes it as window.sb. If config is missing, window.sb stays null and the
// login page shows a setup message instead of breaking.
(function () {
  var cfg = window.FLEET_CONFIG;
  window.sb = null;

  if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return;
  if (cfg.SUPABASE_URL.indexOf('YOUR-PROJECT') !== -1) return;

  window.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
})();
