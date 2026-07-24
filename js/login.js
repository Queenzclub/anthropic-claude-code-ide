// Login page logic: sign in with Supabase Auth, validate the profile,
// then redirect to the dashboard for the user's role.

document.addEventListener('DOMContentLoaded', async function () {
  var form = document.getElementById('loginForm');
  var errorBox = document.getElementById('loginError');
  var configWarning = document.getElementById('configWarning');
  var loginBtn = document.getElementById('loginBtn');

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
  }

  function hideError() {
    errorBox.classList.add('hidden');
  }

  function setBusy(busy) {
    loginBtn.disabled = busy;
    loginBtn.textContent = busy ? 'Logging in…' : 'Log In';
  }

  // Supabase not configured yet: show setup help, disable the form.
  if (!window.sb) {
    configWarning.classList.remove('hidden');
    loginBtn.disabled = true;
    return;
  }

  // Show a message passed from a dashboard redirect (e.g. account inactive).
  var pendingMsg = takeLoginMessage();
  if (pendingMsg) showError(pendingMsg);

  // Already logged in with a valid profile? Go straight to the dashboard.
  var existing = await checkAccess();
  if (existing.ok) {
    window.location.replace(ROLE_PAGES[existing.profile.role]);
    return;
  }
  if (existing.setupRequired) { sendToSetup(); return; }
  if (existing.reason) {
    // Session exists but the profile is unusable — sign out and explain.
    try { await window.sb.auth.signOut(); } catch (e) { /* ignore */ }
    showError(existing.reason);
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    hideError();

    var email = document.getElementById('email').value.trim();
    var password = document.getElementById('password').value;

    if (!email || !password) {
      showError('Please enter your email and password.');
      return;
    }

    setBusy(true);

    var signIn = await window.sb.auth.signInWithPassword({
      email: email,
      password: password,
    });

    if (signIn.error) {
      showError('Invalid email or password.');
      setBusy(false);
      return;
    }

    var result = await checkAccess();
    if (result.setupRequired) {
      // Password set earlier but setup not finalized: keep the password session
      // and route to the Complete Account Setup page (no sign-out).
      sendToSetup();
      return;
    }
    if (!result.ok) {
      try { await window.sb.auth.signOut(); } catch (err) { /* ignore */ }
      showError(result.reason || 'Could not log in. Please try again.');
      setBusy(false);
      return;
    }

    window.location.replace(ROLE_PAGES[result.profile.role]);
  });
});
