// Platform Admin dashboard (Stage 4A) — the Fleet Board Pro platform owner.
//
// Read-only across ALL companies via two SECURITY INVOKER RPCs
// (platform_overview, company_detail), plus the four company-lifecycle
// controls (suspend / reactivate / archive / restore), each a protected
// SECURITY DEFINER RPC that re-checks app_admin server-side. This page has
// NO operational write access to any company's data, never touches auth,
// and never uses anything but the public anon key. Suspend and archive
// require a reason (also enforced in the database).

function initAppAdminPage(ctx) {
  var state = { showArchived: false, companies: [], openId: null };

  var overviewEl = document.getElementById('overviewStats');
  var totalsEl = document.getElementById('totalsStats');
  var companyListEl = document.getElementById('companyList');
  var detailSection = document.getElementById('companyDetailSection');
  var detailHost = document.getElementById('companyDetailHost');
  var showArchivedEl = document.getElementById('showArchived');

  var STATUS_LABEL = {
    active: 'Active', suspended: 'Suspended', archived: 'Archived', pending_setup: 'Pending Setup',
  };
  var STATUS_BADGE = {
    active: 'badge-available', suspended: 'badge-maintenance',
    archived: 'badge-offline', pending_setup: 'badge-pending',
  };

  function companyStatusBadge(status) {
    var cls = STATUS_BADGE[status] || 'badge-offline';
    return '<span class="badge ' + cls + '">' +
      escapeHtml(STATUS_LABEL[status] || status) + '</span>';
  }

  function statTile(num, label) {
    return '<div class="stat"><div class="stat-num">' + escapeHtml(num == null ? 0 : num) +
      '</div><div class="stat-label">' + escapeHtml(label) + '</div></div>';
  }

  // ---------- platform overview + company list ----------

  async function loadOverview() {
    var res;
    try {
      res = await window.sb.rpc('platform_overview', { p_include_archived: state.showArchived });
    } catch (e) { res = { error: e }; }

    if (!res || res.error || !res.data) {
      overviewEl.innerHTML = '';
      totalsEl.innerHTML = '';
      companyListEl.innerHTML =
        '<div class="alert alert-error">Could not load the platform overview. Please try again.</div>';
      return;
    }

    var d = res.data;
    var c = d.companies || {};
    var t = d.totals || {};
    overviewEl.innerHTML =
      statTile(c.total, 'Companies') +
      statTile(c.active, 'Active') +
      statTile(c.suspended, 'Suspended') +
      statTile(c.pending_setup, 'Pending') +
      statTile(c.archived, 'Archived');
    totalsEl.innerHTML =
      statTile(t.company_admins, 'Admins') +
      statTile(t.managers, 'Managers') +
      statTile(t.drivers, 'Drivers') +
      statTile(t.outlets, 'Outlets') +
      statTile(t.vehicles, 'Vehicles') +
      statTile(t.requests, 'Requests');

    state.companies = d.company_list || [];
    renderCompanyList();
  }

  function renderCompanyList() {
    if (!state.companies.length) {
      companyListEl.innerHTML = '<div class="empty muted">No companies to show.</div>';
      return;
    }
    companyListEl.innerHTML = state.companies.map(function (co) {
      return '<article class="card company-card" data-id="' + escapeHtml(co.id) + '">' +
        '<div class="card-top"><strong>' + escapeHtml(co.name) + '</strong>' +
          companyStatusBadge(co.status) + '</div>' +
        '<div class="muted small">🕓 ' + escapeHtml(co.timezone || '') + '</div>' +
        '<div class="request-actions">' +
          '<button class="btn btn-outline btn-small" type="button" data-action="view" data-id="' +
            escapeHtml(co.id) + '">View</button>' +
        '</div></article>';
    }).join('');
  }

  // ---------- company detail ----------

  async function openDetail(companyId) {
    state.openId = companyId;
    detailSection.classList.remove('hidden');
    detailHost.innerHTML = '<div class="report-loading">Loading company…</div>';
    detailSection.scrollIntoView({ block: 'start' });

    var res;
    try { res = await window.sb.rpc('company_detail', { p_company: companyId }); }
    catch (e) { res = { error: e }; }

    if (!res || res.error || !res.data) {
      detailHost.innerHTML =
        '<div class="alert alert-error">Could not load this company. Please try again.</div>';
      return;
    }
    renderDetail(res.data);
  }

  function groupHtml(title, itemsHtml, count) {
    return '<div class="detail-group">' +
      '<h4>' + escapeHtml(title) + ' <span class="muted small">(' + count + ')</span></h4>' +
      (itemsHtml || '<div class="muted small">None.</div>') + '</div>';
  }

  function personRows(list) {
    if (!list || !list.length) return '';
    return list.map(function (p) {
      return '<div class="detail-row"><span>' + escapeHtml(p.name || '—') + '</span>' +
        (p.active ? '' : '<span class="badge badge-offline">Inactive</span>') + '</div>';
    }).join('');
  }

  function driverRows(list) {
    if (!list || !list.length) return '';
    return list.map(function (d) {
      var veh = d.vehicle_name
        ? escapeHtml(d.vehicle_name) + (d.vehicle_plate ? ' · ' + escapeHtml(d.vehicle_plate) : '')
        : '<span class="muted">No vehicle</span>';
      var chips = (d.on_duty ? '<span class="badge badge-available">On Duty</span>' : '') +
        (d.active ? '' : '<span class="badge badge-offline">Inactive</span>');
      return '<div class="detail-row"><span>' + escapeHtml(d.name || '—') +
        '<br><span class="muted small">🚐 ' + veh + '</span></span><span>' + chips + '</span></div>';
    }).join('');
  }

  function vehicleRows(list) {
    if (!list || !list.length) return '';
    return list.map(function (v) {
      var km = (v.current_km != null) ? ' · ' + escapeHtml(v.current_km) + ' km' : '';
      var drv = v.driver_name ? ' · 👤 ' + escapeHtml(v.driver_name) : '';
      return '<div class="detail-row"><span>' + escapeHtml(v.vehicle_name || '—') +
        (v.plate_number ? ' · ' + escapeHtml(v.plate_number) : '') +
        '<br><span class="muted small">' + statusBadge(v.status) + drv + km + '</span></span>' +
        (v.active ? '' : '<span class="badge badge-offline">Inactive</span>') + '</div>';
    }).join('');
  }

  function lifecycleButtons(status) {
    var b = [];
    if (status === 'active') b.push('<button class="btn btn-warn btn-small" type="button" data-action="suspend">Suspend</button>');
    if (status === 'suspended') b.push('<button class="btn btn-primary btn-small" type="button" data-action="reactivate">Reactivate</button>');
    if (status === 'active' || status === 'suspended') b.push('<button class="btn btn-danger btn-small" type="button" data-action="archive">Archive</button>');
    if (status === 'archived') b.push('<button class="btn btn-primary btn-small" type="button" data-action="restore">Restore</button>');
    return b.join('');
  }

  function renderDetail(d) {
    var co = d.company || {};
    var counts = d.counts || {};
    var meta = 'Code ' + escapeHtml(co.code || '—') + ' · 🕓 ' + escapeHtml(co.timezone || '') +
      ' · created ' + escapeHtml(fmtTime(co.created_at));
    var extra = '';
    if (co.status === 'suspended' && co.suspension_reason) {
      extra += '<p class="detail-note">⛔ Suspended: ' + escapeHtml(co.suspension_reason) + '</p>';
    }
    if (co.status === 'archived' && co.archived_at) {
      extra += '<p class="detail-note">🗄️ Archived ' + escapeHtml(fmtTime(co.archived_at)) + '</p>';
    }

    detailHost.innerHTML =
      '<div class="detail-head">' +
        '<div><h4>' + escapeHtml(co.name || '—') + '</h4>' +
          '<div class="muted small">' + meta + '</div></div>' +
        companyStatusBadge(co.status) +
      '</div>' +
      extra +
      '<div class="request-actions" id="lifecycleActions">' + lifecycleButtons(co.status) + '</div>' +
      '<div id="lifecycleForm"></div>' +
      '<div class="stats detail-counts">' +
        statTile(counts.drivers, 'Drivers') +
        statTile(counts.outlets, 'Outlets') +
        statTile(counts.vehicles, 'Vehicles') +
        statTile(counts.requests, 'Requests') +
        statTile(counts.active_jobs, 'Active Jobs') +
      '</div>' +
      '<div class="detail-grid">' +
        groupHtml('Company Admins', personRows(d.company_admins), (d.company_admins || []).length) +
        groupHtml('Managers', personRows(d.managers), (d.managers || []).length) +
        groupHtml('Drivers', driverRows(d.drivers), (d.drivers || []).length) +
        groupHtml('Outlets', personRows(d.outlets), (d.outlets || []).length) +
        groupHtml('Vehicles', vehicleRows(d.vehicles), (d.vehicles || []).length) +
      '</div>';
  }

  // ---------- lifecycle actions ----------

  var RPC_FOR = {
    suspend: 'suspend_company',
    reactivate: 'reactivate_company',
    archive: 'archive_company',
    restore: 'restore_archived_company',
  };
  var NEEDS_REASON = { suspend: 'suspension', archive: 'archive' };

  // Inline reason form for suspend / archive (required). Reactivate / restore
  // run immediately.
  function promptReason(action) {
    var host = document.getElementById('lifecycleForm');
    if (!host) return;
    var word = NEEDS_REASON[action];
    host.innerHTML =
      '<div class="card reason-card">' +
        '<label>' + (action === 'suspend' ? 'Suspension' : 'Archive') + ' reason (required)</label>' +
        '<textarea id="reasonInput" rows="2" placeholder="Why is this company being ' +
          (action === 'suspend' ? 'suspended' : 'archived') + '?"></textarea>' +
        '<div class="request-actions">' +
          '<button class="btn btn-primary btn-small" type="button" data-action="confirm-' + action + '">Confirm</button>' +
          '<button class="btn btn-outline btn-small" type="button" data-action="cancel-reason">Cancel</button>' +
        '</div>' +
      '</div>';
    var ta = document.getElementById('reasonInput');
    if (ta) ta.focus();
  }

  async function runLifecycle(action, reason) {
    var rpc = RPC_FOR[action];
    if (!rpc || !state.openId) return;
    if (NEEDS_REASON[action] && !(reason && reason.trim())) {
      showFlash('Please enter a reason.', 'error');
      return;
    }
    var params = { p_company: state.openId };
    if (NEEDS_REASON[action]) params.p_reason = reason.trim();

    var res;
    try { res = await window.sb.rpc(rpc, params); }
    catch (e) { res = { error: e }; }

    if (!res || res.error) {
      var msg = (res && res.error && res.error.message) ? res.error.message : 'Action failed. Please try again.';
      showFlash(msg, 'error');
      return;
    }
    var done = { suspend: 'Company suspended.', reactivate: 'Company reactivated.',
                 archive: 'Company archived.', restore: 'Company restored.' };
    showFlash(done[action] || 'Done.', 'success');
    await loadOverview();
    await openDetail(state.openId);   // re-open so the buttons + status refresh
  }

  // ---------- events ----------

  companyListEl.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action="view"]');
    if (btn) openDetail(btn.getAttribute('data-id'));
  });

  detailHost.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');
    if (action === 'suspend' || action === 'archive') { promptReason(action); return; }
    if (action === 'reactivate' || action === 'restore') { runLifecycle(action, null); return; }
    if (action === 'cancel-reason') { var h = document.getElementById('lifecycleForm'); if (h) h.innerHTML = ''; return; }
    if (action === 'confirm-suspend' || action === 'confirm-archive') {
      var ta = document.getElementById('reasonInput');
      runLifecycle(action.replace('confirm-', ''), ta ? ta.value : '');
    }
  });

  showArchivedEl.addEventListener('change', function () {
    state.showArchived = showArchivedEl.checked;
    loadOverview();
  });

  var refreshBtn = document.getElementById('refreshAll');
  if (refreshBtn) refreshBtn.addEventListener('click', function () {
    loadOverview();
    if (state.openId && !detailSection.classList.contains('hidden')) openDetail(state.openId);
  });

  var closeBtn = document.getElementById('closeDetail');
  if (closeBtn) closeBtn.addEventListener('click', function () {
    detailSection.classList.add('hidden');
    state.openId = null;
  });

  loadOverview();
}
