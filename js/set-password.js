// Set-password page (Stage 4B-2): consumes the invite / password-recovery
// email link and lets the user choose their own password.
//
// Security rules:
//  * A valid link mints an authentication-capable session, so this page is
//    the GATE: it never routes into the application. Only after
//    auth.updateUser({ password }) succeeds does it sign out and send the
//    user to the login page.
//  * Tokens, hash fragments and links are never rendered or logged; the URL
//    hash is stripped as soon as it has been consumed.
//  * Minimum password length 8 (Supabase remains the server-side authority).
//  * Works under the GitHub Pages repository path: all URLs are relative.

(function () {
  var MIN_LEN = 8;

  function show(id) {
    ['spWaiting', 'spForm', 'spExpired', 'spDone'].forEach(function (x) {
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

  document.addEventListener('DOMContentLoaded', function () {
    document.body.classList.remove('loading');
    document.body.classList.add('ready');

    if (!window.sb) { show('spExpired'); return; }

    // Detect an explicit error from the auth redirect (e.g. otp_expired),
    // BEFORE stripping the hash. The hash itself is never shown or logged.
    var rawHash = window.location.hash || '';
    var hashSaysError = /error=|error_code=/.test(rawHash);

    var settled = false;
    function haveSession() {
      if (settled) return;
      settled = true;
      stripHash();
      show('spForm');
    }
    function noSession() {
      if (settled) return;
      settled = true;
      stripHash();
      show('spExpired');
    }
    function stripHash() {
      try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { /* ignore */ }
    }

    if (hashSaysError) { noSession(); return; }

    // supabase-js (detectSessionInUrl) consumes the invite/recovery hash and
    // emits SIGNED_IN / PASSWORD_RECOVERY once the session exists.
    window.sb.auth.onAuthStateChange(function (event, session) {
      if (session) haveSession();
    });
    window.sb.auth.getSession().then(function (r) {
      if (r && r.data && r.data.session) haveSession();
      else setTimeout(function () {
        window.sb.auth.getSession().then(function (r2) {
          if (r2 && r2.data && r2.data.session) haveSession(); else noSession();
        });
      }, 1500);   // give detectSessionInUrl a moment on slow devices
    });

    var form = document.getElementById('spForm');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      msg('');
      var pw = document.getElementById('spPassword').value;
      var confirm = document.getElementById('spConfirm').value;
      if (pw.length < MIN_LEN) { msg('Please use at least ' + MIN_LEN + ' characters.'); return; }
      if (pw !== confirm) { msg('The passwords do not match.'); return; }

      var btn = document.getElementById('spSubmit');
      btn.disabled = true;
      btn.textContent = 'Setting password…';

      var res;
      try { res = await window.sb.auth.updateUser({ password: pw }); }
      catch (err) { res = { error: err }; }

      if (res && res.error) {
        btn.disabled = false;
        btn.textContent = 'Set Password';
        msg('Could not set the password. Please try again, or ask for a new setup email.');
        return;
      }

      // Success — and ONLY now: leave the invite session and go to login.
      show('spDone');
      try { sessionStorage.setItem('fleet_login_msg', 'Your password is set. Please log in.'); } catch (err) { /* ignore */ }
      try { await window.sb.auth.signOut(); } catch (err) { /* ignore */ }
      window.location.replace('index.html');
    });
  });
})();
