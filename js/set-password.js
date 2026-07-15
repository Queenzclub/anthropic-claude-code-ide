// Set-password page (Stage 4B security amendment).
//
// This page is the DATABASE-ENFORCED setup boundary for an invited first
// Company Admin. It NEVER routes into the application. The real access decision
// lives in the database: the finalize_first_admin_setup() RPC (called through
// the complete-first-admin-setup Edge Function) requires a genuine
// password-authenticated session and activates the profile only then.
//
// Flow (proof method: AMR password claim from a fresh sign-in — see the local
// GoTrue evidence in the amendment report):
//   1. Consume the invite / recovery callback (hash flow, or PKCE ?code=).
//   2. Gate on my_first_admin_setup_status().required — the DB's authoritative
//      answer to "is this a valid setup session?" An ordinary logged-in session
//      (required=false) is REJECTED here; it never sees the password form.
//   3. auth.updateUser({ password }) sets the password.
//   4. signOut, then signInWithPassword -> a FRESH password-authenticated
//      session (its JWT carries amr method="password"; the invite/recovery
//      session carried "otp" and updateUser does not upgrade it in place).
//   5. Call complete-first-admin-setup with that fresh session. Require success.
//   6. Only on success: sign out and go to the login page.
//   * On ANY failure the user is never routed into the app; a safe retry /
//     support message is shown and (where a session lingers) it is cleared.
//   * Tokens / hash fragments / links are never rendered or logged; the URL
//     hash is stripped as soon as it has been consumed.

(function () {
  var MIN_LEN = 8;

  function show(id) {
    ['spWaiting', 'spForm', 'spExpired', 'spReject', 'spDone'].forEach(function (x) {
      var el = document.getElementById(x);
      if (el) el.classList.toggle('hidden', x !== id);
    });
  }
  function msg(text, isError) {
    var el = document.getElementById('spMsg');
    if (el) {
      el.innerHTML = text
        ? '<div class="alert ' + (isError === false ? 'alert-success' : 'alert-error') + '"></div>'
        : '';
      if (text) el.firstChild.textContent = text;   // textContent: never render markup
    }
  }
  function stripHash() {
    try { history.replaceState(null, '', window.location.pathname + window.location.search); }
    catch (e) { /* ignore */ }
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.body.classList.remove('loading');
    document.body.classList.add('ready');

    if (!window.sb) { show('spExpired'); return; }

    // Explicit auth-redirect error (e.g. otp_expired) — detect BEFORE stripping.
    var rawHash = window.location.hash || '';
    if (/error=|error_code=/.test(rawHash)) { stripHash(); show('spExpired'); return; }

    start();
  });

  async function getSession() {
    var r = await window.sb.auth.getSession();
    return (r && r.data && r.data.session) ? r.data.session : null;
  }

  // Waits briefly for supabase-js (detectSessionInUrl) to materialize a session
  // from the callback on slower devices.
  async function waitForSession() {
    var s = await getSession();
    if (s) return s;
    await new Promise(function (r) { setTimeout(r, 1200); });
    return await getSession();
  }

  async function start() {
    // PKCE / code-based callback support (used only if the project enables the
    // PKCE flow; the default hash flow is handled by detectSessionInUrl).
    try {
      var url = new URL(window.location.href);
      var code = url.searchParams.get('code');
      if (code && window.sb.auth.exchangeCodeForSession) {
        await window.sb.auth.exchangeCodeForSession(code);
      }
    } catch (e) { /* fall through to session check */ }

    var session = await waitForSession();
    stripHash();
    if (!session) { show('spExpired'); return; }

    // DB-authoritative gate: only a pending first-admin setup may proceed.
    var required = false;
    try {
      var r = await window.sb.rpc('my_first_admin_setup_status');
      required = !!(r && !r.error && r.data && r.data.required);
    } catch (e) { required = false; }

    if (!required) {
      // Ordinary existing session (or a non-setup user): never show the form.
      show('spReject');
      return;
    }

    show('spForm');
    wireForm(session);
  }

  function wireForm(session) {
    var form = document.getElementById('spForm');
    var btn = document.getElementById('spSubmit');
    var mode = 'full';          // 'full' = whole pipeline; 'finalize' = retry finalize only

    function setBusy(on, label) {
      btn.disabled = on;
      if (label) btn.textContent = label;
    }
    function offerFinalizeRetry(text) {
      mode = 'finalize';
      setBusy(false, 'Try again');
      msg(text, true);
    }

    async function finalizeStep() {
      setBusy(true, 'Finishing setup…');
      var fin;
      try { fin = await window.sb.functions.invoke('complete-first-admin-setup', { body: {} }); }
      catch (err) { fin = { error: err }; }
      if (fin && !fin.error && fin.data && fin.data.finalized) {
        // Success — and ONLY now: leave the session and go to login.
        show('spDone');
        try { sessionStorage.setItem('fleet_login_msg', 'Your account setup is complete. Please log in.'); } catch (e) { /* ignore */ }
        try { await window.sb.auth.signOut(); } catch (e) { /* ignore */ }
        window.location.replace('index.html');
        return;
      }
      // Finalization failed. We hold a password session but stay OUT of the app.
      offerFinalizeRetry('We saved your password but could not finish setting up your account. Please try again, or ask your administrator to resend your setup email.');
    }

    async function fullSetup() {
      msg('');
      var pw = document.getElementById('spPassword').value;
      var confirm = document.getElementById('spConfirm').value;
      if (pw.length < MIN_LEN) { msg('Please use at least ' + MIN_LEN + ' characters.'); return; }
      if (pw !== confirm) { msg('The passwords do not match.'); return; }

      setBusy(true, 'Setting password…');

      // 1) Set the password on the invite/recovery session.
      var upd;
      try { upd = await window.sb.auth.updateUser({ password: pw }); }
      catch (err) { upd = { error: err }; }
      if (upd && upd.error) {
        setBusy(false, 'Set Password');
        msg('Could not set the password. Please try again, or ask for a new setup email.');
        return;
      }

      // 2) Capture the email safely from the authenticated session.
      var email = (session && session.user && session.user.email) || '';
      if (!email) {
        try { var u = await window.sb.auth.getUser(); email = (u && u.data && u.data.user && u.data.user.email) || ''; }
        catch (e) { /* ignore */ }
      }

      // 3) Drop the invite/recovery session and obtain a FRESH password session.
      try { await window.sb.auth.signOut(); } catch (e) { /* ignore */ }
      var login;
      try { login = await window.sb.auth.signInWithPassword({ email: email, password: pw }); }
      catch (err) { login = { error: err }; }
      if (!login || login.error || !login.data || !login.data.session) {
        // Cannot establish the password proof — do not enter the app.
        try { await window.sb.auth.signOut(); } catch (e) { /* ignore */ }
        setBusy(false, 'Set Password');
        msg('Your password was saved, but we could not verify it just now. Please ask your administrator to resend your setup email, then use the newest link.');
        return;
      }

      // 4) Finalize with the fresh password session (retryable on failure).
      await finalizeStep();
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (mode === 'finalize') { finalizeStep(); return; }
      fullSetup();
    });
  }
})();
