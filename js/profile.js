// My Profile page: shows the logged-in user their own profile only.
// Works for every role. All reads are the caller's own rows (own
// profile, own company, own outlet, own driver record) — no wider
// access is requested, and RLS enforces it regardless.

function initProfilePage(ctx) {
  var profile = ctx.profile;
  var user = ctx.user;
  var el = document.getElementById('profileCard');

  function row(label, value) {
    if (value == null || value === '') return '';
    return '<div class="profile-row"><span class="profile-label">' + escapeHtml(label) +
      '</span><span class="profile-value">' + value + '</span></div>';
  }

  async function render() {
    // Company / outlet / driver names — each is the caller's own row.
    var companyName = '';
    var outletName = '';
    var driverName = '';

    if (profile.company_id) {
      var c = await window.sb.from('companies').select('name').eq('id', profile.company_id).maybeSingle();
      if (c.data) companyName = c.data.name;
    }
    if (profile.outlet_id) {
      var o = await window.sb.from('outlets').select('name').eq('id', profile.outlet_id).maybeSingle();
      if (o.data) outletName = o.data.name;
    }
    if (profile.driver_id) {
      var d = await window.sb.from('drivers').select('name').eq('id', profile.driver_id).maybeSingle();
      if (d.data) driverName = d.data.name;
    }

    var roleBadge = '<span class="badge badge-role-' + escapeHtml(profile.role) + '">' +
      escapeHtml(ROLE_LABELS[profile.role] || profile.role) + '</span>';
    var activeBadge = profile.active
      ? '<span class="badge badge-available">Active</span>'
      : '<span class="badge badge-offline">Inactive</span>';

    var lastLogin = user && user.last_sign_in_at ? fmtTime(user.last_sign_in_at) : '';
    var since = profile.created_at ? fmtTime(profile.created_at) : '';

    var html = '';
    html += row('Name', escapeHtml(profile.name || '—'));
    html += row('Email', escapeHtml(profile.email || user.email || '—'));
    html += row('Phone', escapeHtml(profile.phone || '—'));
    html += row('Role', roleBadge);
    html += row('Status', activeBadge);
    html += row('Company', escapeHtml(companyName || '—'));
    if (profile.role === 'outlet') html += row('Outlet', escapeHtml(outletName || '—'));
    if (profile.role === 'driver') html += row('Driver record', escapeHtml(driverName || '—'));
    if (since) html += row('Member since', escapeHtml(since));
    if (lastLogin) html += row('Last login', escapeHtml(lastLogin));

    el.innerHTML = html;

    // "Back to dashboard" goes to this user's own dashboard.
    var back = document.getElementById('backBtn');
    if (back) back.setAttribute('href', ROLE_PAGES[profile.role] || 'index.html');
  }

  document.getElementById('logoutBtn').addEventListener('click', function () { sendToLogin(null); });
  render();
}
