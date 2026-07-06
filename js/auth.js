// Shared auth helpers: session + profile checks, role guard, logout.
// Used by the login page and every dashboard page.

var ROLE_PAGES = {
  admin: 'admin.html',
  manager: 'manager.html',
  outlet: 'outlet.html',
  driver: 'driver.html',
};

var ROLE_LABELS = {
  admin: 'Admin',
  manager: 'Manager',
  outlet: 'Outlet',
  driver: 'Driver',
};

// One-shot message passed to the login page (e.g. "account inactive").
function setLoginMessage(msg) {
  try { sessionStorage.setItem('fleet_login_msg', msg); } catch (e) { /* ignore */ }
}

function takeLoginMessage() {
  try {
    var msg = sessionStorage.getItem('fleet_login_msg');
    sessionStorage.removeItem('fleet_login_msg');
    return msg;
  } catch (e) { return null; }
}

// Checks the current session AND that the profile is usable.
// Returns { ok:true, user, profile } or { ok:false, reason }.
// reason is null when simply not logged in.
async function checkAccess() {
  var sessionResult = await window.sb.auth.getSession();
  var session = sessionResult.data ? sessionResult.data.session : null;
  if (!session) return { ok: false, reason: null };

  var res = await window.sb
    .from('profiles')
    .select('user_id, company_id, role, name, email, phone, active, outlet_id, driver_id, vehicle_id, created_at')
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (res.error) {
    return { ok: false, reason: 'Could not load your profile. Please try again.' };
  }
  if (!res.data) {
    return { ok: false, reason: 'Profile not found. Please contact your admin.' };
  }
  if (!res.data.active) {
    return { ok: false, reason: 'Your account is not active yet. Please contact your admin.' };
  }
  if (!ROLE_PAGES[res.data.role]) {
    return { ok: false, reason: 'Your role is not assigned yet. Please contact your admin.' };
  }
  return { ok: true, user: session.user, profile: res.data };
}

// Signs out and returns to the login page, optionally with a message.
async function sendToLogin(message) {
  if (message) setLoginMessage(message);
  try { await window.sb.auth.signOut(); } catch (e) { /* ignore */ }
  window.location.replace('index.html');
}

// Route guard for dashboard pages. Redirects when the user is not
// logged in, not usable, or on the wrong role's page.
async function guardPage(expectedRole) {
  if (!window.sb) {
    window.location.replace('index.html');
    return null;
  }
  var result = await checkAccess();
  if (!result.ok) {
    await sendToLogin(result.reason);
    return null;
  }
  if (result.profile.role !== expectedRole) {
    // Logged in, but this is someone else's dashboard — send them home.
    window.location.replace(ROLE_PAGES[result.profile.role]);
    return null;
  }
  return result;
}

// Fills the shared header (name, role, company), wires logout, reveals page.
async function applyChrome(ctx) {
  var profile = ctx.profile;
  var nameEl = document.getElementById('userName');
  var emailEl = document.getElementById('userEmail');
  var badgeEl = document.getElementById('roleBadge');
  var companyEl = document.getElementById('companyName');

  if (nameEl) nameEl.textContent = profile.name || profile.email || ctx.user.email;
  if (emailEl) emailEl.textContent = profile.email || ctx.user.email || '';
  if (badgeEl) {
    badgeEl.textContent = ROLE_LABELS[profile.role];
    badgeEl.classList.add('badge-role-' + profile.role);
    // Outlet accounts show their shop name instead of a generic label.
    if (profile.role === 'outlet' && profile.outlet_id) {
      var outletRes = await window.sb
        .from('outlets').select('name').eq('id', profile.outlet_id).maybeSingle();
      if (outletRes.data && outletRes.data.name) badgeEl.textContent = outletRes.data.name;
    }
  }

  if (companyEl && profile.company_id) {
    var companyRes = await window.sb
      .from('companies')
      .select('name')
      .eq('id', profile.company_id)
      .maybeSingle();
    if (companyRes.data) companyEl.textContent = companyRes.data.name;
  }

  var logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () { sendToLogin(null); });
  }

  document.body.classList.remove('loading');
  document.body.classList.add('ready');
  return ctx;
}

// Guard + chrome for a role-specific dashboard page.
async function initDashboard(expectedRole) {
  var ctx = await guardPage(expectedRole);
  if (!ctx) return null;
  return applyChrome(ctx);
}

// Guard + chrome for a page any active user may see (e.g. My Profile).
// Redirects to login when not logged in / not usable, but does not
// bounce between roles.
async function initAnyRolePage() {
  if (!window.sb) {
    window.location.replace('index.html');
    return null;
  }
  var result = await checkAccess();
  if (!result.ok) {
    await sendToLogin(result.reason);
    return null;
  }
  return applyChrome(result);
}
