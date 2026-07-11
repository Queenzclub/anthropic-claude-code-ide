// Stage 3D — Daily / date-range Reports (Company Admin + Manager only).
//
// Calls the company_report RPC (Migration 22) and renders it. The RPC is
// company-scoped and staff-guarded server-side; this module is only loaded
// on the admin and manager pages, so Driver/Outlet never see a Reports
// section. Date-range metrics are kept visually separate from the current
// ("Right now") snapshot. Null rates/averages render as "—". The status
// filter is labelled "Recent Jobs Status" because it only narrows the
// recent-jobs list, never the summary/rollups/snapshot.

function initReports(ctx) {
  if (!ctx || !ctx.profile) return;
  if (ctx.profile.role !== 'admin' && ctx.profile.role !== 'manager') return;
  var host = document.getElementById('reportHost');
  if (!host) return;

  var state = { preset: 'today', from: null, to: null, vehicle: '', driver: '', status: '' };
  var tz = null;                 // company timezone (for correct "Today")
  var lastParams = null;

  // ---------- date helpers (calendar-date math, tz-aware presets) ----------
  function ymdInTz(date, zone) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(date);
    } catch (e) {
      return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    }
  }
  function addDays(ymd, n) {
    var d = new Date(ymd + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function presetRange(preset) {
    var today = ymdInTz(new Date(), tz);
    if (preset === 'today') return { from: today, to: today };
    if (preset === 'yesterday') { var y = addDays(today, -1); return { from: y, to: y }; }
    if (preset === '7d') return { from: addDays(today, -6), to: today };
    if (preset === 'month') return { from: today.slice(0, 7) + '-01', to: today };
    return null; // custom
  }

  // ---------- value formatting ----------
  function dash(v) { return (v === null || v === undefined || v === '') ? '—' : v; }
  function fmtNum(v) { return (v === null || v === undefined) ? '—' : String(v); }
  function fmtRate(r) { return (r === null || r === undefined) ? '—' : Math.round(Number(r) * 100) + '%'; }
  function fmtDuration(s) {
    if (s === null || s === undefined) return '—';
    s = Number(s);
    if (!isFinite(s)) return '—';
    if (s < 60) return Math.round(s) + 's';
    var m = Math.floor(s / 60), sec = Math.round(s % 60);
    if (m < 60) return m + 'm' + (sec ? ' ' + sec + 's' : '');
    var h = Math.floor(m / 60), mm = m % 60;
    return h + 'h' + (mm ? ' ' + mm + 'm' : '');
  }
  function recentWhen(j) {
    return fmtTime(j.completed_at || j.cancelled_at || j.started_at || j.accepted_at || j.created_at);
  }
  function activeTag(isActive) {
    return isActive === false ? ' <span class="muted small">(inactive)</span>' : '';
  }

  // ---------- controls ----------
  host.innerHTML =
    '<div class="report-controls">' +
      '<div class="filter-bar" data-role="report-presets">' +
        '<button class="filter-btn active" type="button" data-preset="today">Today</button>' +
        '<button class="filter-btn" type="button" data-preset="yesterday">Yesterday</button>' +
        '<button class="filter-btn" type="button" data-preset="7d">Last 7 Days</button>' +
        '<button class="filter-btn" type="button" data-preset="month">This Month</button>' +
        '<button class="filter-btn" type="button" data-preset="custom">Custom</button>' +
      '</div>' +
      '<div class="report-filters">' +
        '<div class="field report-dates hidden" data-role="report-customdates">' +
          '<label>From <input type="date" data-role="report-from"></label>' +
          '<label>To <input type="date" data-role="report-to"></label>' +
        '</div>' +
        '<div class="field"><label>Vehicle</label>' +
          '<select data-role="report-vehicle"><option value="">All vehicles</option></select></div>' +
        '<div class="field"><label>Driver</label>' +
          '<select data-role="report-driver"><option value="">All drivers</option></select></div>' +
        '<div class="field"><label>Recent Jobs Status</label>' +
          '<select data-role="report-status">' +
            '<option value="">All statuses</option>' +
            '<option value="pending">Pending</option>' +
            '<option value="accepted">Accepted</option>' +
            '<option value="in_progress">In Progress</option>' +
            '<option value="completed">Completed</option>' +
            '<option value="cancelled">Cancelled</option>' +
          '</select></div>' +
        '<div class="field report-run"><button class="btn btn-primary" type="button" data-role="report-run">View Report</button></div>' +
      '</div>' +
    '</div>' +
    '<div id="reportBody" class="report-body"></div>';

  var bodyEl = host.querySelector('#reportBody');
  var presetsEl = host.querySelector('[data-role="report-presets"]');
  var customEl = host.querySelector('[data-role="report-customdates"]');
  var fromEl = host.querySelector('[data-role="report-from"]');
  var toEl = host.querySelector('[data-role="report-to"]');
  var vehicleEl = host.querySelector('[data-role="report-vehicle"]');
  var driverEl = host.querySelector('[data-role="report-driver"]');
  var statusEl = host.querySelector('[data-role="report-status"]');
  var runEl = host.querySelector('[data-role="report-run"]');

  presetsEl.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-preset]');
    if (!btn) return;
    state.preset = btn.getAttribute('data-preset');
    Array.prototype.forEach.call(presetsEl.querySelectorAll('.filter-btn'), function (b) {
      b.classList.toggle('active', b === btn);
    });
    customEl.classList.toggle('hidden', state.preset !== 'custom');
    if (state.preset !== 'custom') run();
  });
  runEl.addEventListener('click', run);

  // ---------- populate filter options ----------
  async function loadOptions() {
    var vRes = await window.sb.from('vehicles').select('id, vehicle_name, plate_number').order('vehicle_name');
    if (vRes && !vRes.error && vRes.data) {
      vehicleEl.innerHTML = '<option value="">All vehicles</option>' + vRes.data.map(function (v) {
        return '<option value="' + escapeHtml(v.id) + '">' + escapeHtml(v.vehicle_name) +
          (v.plate_number ? ' (' + escapeHtml(v.plate_number) + ')' : '') + '</option>';
      }).join('');
    }
    var dRes = await window.sb.from('drivers').select('id, name').order('name');
    if (dRes && !dRes.error && dRes.data) {
      driverEl.innerHTML = '<option value="">All drivers</option>' + dRes.data.map(function (d) {
        return '<option value="' + escapeHtml(d.id) + '">' + escapeHtml(d.name) + '</option>';
      }).join('');
    }
  }

  async function loadTimezone() {
    if (!ctx.profile.company_id) return;
    var res = await window.sb.from('companies').select('timezone').eq('id', ctx.profile.company_id).maybeSingle();
    if (res && !res.error && res.data && res.data.timezone) tz = res.data.timezone;
  }

  // ---------- run ----------
  function currentRange() {
    if (state.preset === 'custom') {
      return { from: (fromEl.value || '').trim(), to: (toEl.value || '').trim() };
    }
    return presetRange(state.preset);
  }

  async function run() {
    var range = currentRange();
    if (!range || !range.from || !range.to) {
      bodyEl.innerHTML = '<div class="empty-state">Pick a start and end date.</div>';
      return;
    }
    state.vehicle = vehicleEl.value || '';
    state.driver = driverEl.value || '';
    state.status = statusEl.value || '';

    var params = {
      p_start_date: range.from,
      p_end_date: range.to,
      p_vehicle: state.vehicle || null,
      p_driver: state.driver || null,
      p_status: state.status || null,
    };
    lastParams = params;
    bodyEl.innerHTML = '<div class="report-loading">Loading report…</div>';
    runEl.disabled = true;

    var res;
    try {
      res = await window.sb.rpc('company_report', params);
    } catch (e) {
      res = { error: e };
    }
    runEl.disabled = false;
    if (lastParams !== params) return; // a newer run superseded this one

    if (!res || res.error || !res.data) {
      var msg = (res && res.error && res.error.message) ? res.error.message : 'Could not load the report. Please try again.';
      bodyEl.innerHTML = '<div class="alert alert-error">' + escapeHtml(msg) + '</div>' +
        '<div class="request-actions"><button class="btn btn-outline" type="button" data-role="report-retry">Try again</button></div>';
      var retry = bodyEl.querySelector('[data-role="report-retry"]');
      if (retry) retry.addEventListener('click', run);
      return;
    }
    render(res.data);
  }

  // ---------- render ----------
  function statTile(num, label) {
    return '<div class="stat"><div class="stat-num">' + escapeHtml(num) + '</div>' +
      '<div class="stat-label">' + escapeHtml(label) + '</div></div>';
  }

  function render(rep) {
    var s = rep.summary || {};
    var snap = rep.current_snapshot || {};
    var sv = snap.vehicles || {};
    var vehicles = rep.vehicles || [];
    var drivers = rep.drivers || [];
    var recent = rep.recent_jobs || [];
    var range = rep.range || {};

    var rangeMetrics = Number(s.requests_created || 0) + Number(s.completed || 0) +
      Number(s.cancelled || 0) + Number(s.accepted || 0);
    var rangeEmpty = rangeMetrics === 0 && vehicles.length === 0 && drivers.length === 0 && recent.length === 0;

    var html = '';

    // Range header
    html += '<p class="report-range muted">Range: <strong>' + escapeHtml(range.start_date) + '</strong> to <strong>' +
      escapeHtml(range.end_date) + '</strong>' + (range.timezone ? ' · ' + escapeHtml(range.timezone) : '') + '</p>';

    // --- Date-range metrics ---
    html += '<div class="report-block"><h4 class="report-h">For the selected range</h4>';
    if (rangeEmpty) {
      html += '<div class="empty-state">No activity in this range.</div>';
    } else {
      html += '<div class="stats">' +
        statTile(fmtNum(s.requests_created), 'Requests created') +
        statTile(fmtNum(s.accepted), 'Accepted') +
        statTile(fmtNum(s.completed), 'Completed') +
        statTile(fmtNum(s.cancelled), 'Cancelled') +
        statTile(fmtRate(s.completion_rate), 'Completion rate (of closed jobs)') +
        statTile(fmtNum(s.total_km), 'Total KM') +
        statTile(fmtNum(s.fuel_liters), 'Fuel (L)') +
        statTile(fmtNum(s.fuel_cost), 'Fuel cost') +
        statTile(fmtDuration(s.avg_delivery_seconds), 'Avg delivery time') +
        statTile(fmtDuration(s.avg_request_to_accept_seconds), 'Avg request → accept') +
        statTile(fmtDuration(s.avg_accepted_to_start_seconds), 'Avg accepted → start') +
        statTile(fmtDuration(s.run_seconds), 'Total run time') +
        '</div>';
    }
    html += '</div>';

    // --- Right now (current snapshot) ---
    html += '<div class="report-block report-now"><h4 class="report-h">Right now</h4>' +
      '<div class="stats">' +
        statTile(fmtNum(snap.pending_now), 'Pending now') +
        statTile(fmtNum(snap.active_now), 'Active now') +
        statTile(fmtNum(snap.drivers_on_duty), 'Drivers on duty') +
      '</div>' +
      '<div class="report-vehstatus">' +
        nowBadge('Available', sv.available) + nowBadge('Busy', sv.busy) +
        nowBadge('Offline', sv.offline) + nowBadge('Maintenance', sv.maintenance) +
        nowBadge('Service Due', sv.service_due) + nowBadge('In Service', sv.in_service) +
        nowBadge('Damaged', sv.damaged) +
      '</div></div>';

    // --- Vehicles table ---
    html += '<div class="report-block"><h4 class="report-h">Vehicles</h4>';
    if (!vehicles.length) {
      html += '<div class="empty-state">No vehicles to show.</div>';
    } else {
      html += '<div class="table-scroll"><table class="report-table"><thead><tr>' +
        '<th>Vehicle</th><th>Status</th><th>Completed</th><th>Cancelled</th><th>KM</th>' +
        '<th>Fuel L</th><th>Fuel cost</th><th>Avg delivery</th></tr></thead><tbody>' +
        vehicles.map(function (v) {
          return '<tr><td>' + escapeHtml(v.name) + activeTag(v.active) +
            (v.plate ? '<br><span class="muted small">' + escapeHtml(v.plate) + '</span>' : '') + '</td>' +
            '<td>' + statusBadge(v.status) + '</td>' +
            '<td>' + fmtNum(v.completed) + '</td><td>' + fmtNum(v.cancelled) + '</td>' +
            '<td>' + fmtNum(v.total_km) + '</td><td>' + fmtNum(v.fuel_liters) + '</td>' +
            '<td>' + fmtNum(v.fuel_cost) + '</td><td>' + fmtDuration(v.avg_delivery_seconds) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    html += '</div>';

    // --- Drivers table ---
    html += '<div class="report-block"><h4 class="report-h">Drivers</h4>';
    if (!drivers.length) {
      html += '<div class="empty-state">No drivers to show.</div>';
    } else {
      html += '<div class="table-scroll"><table class="report-table"><thead><tr>' +
        '<th>Driver</th><th>Duty</th><th>Accepted</th><th>Completed</th><th>Cancelled</th>' +
        '<th>KM</th><th>Avg response</th><th>Avg delivery</th></tr></thead><tbody>' +
        drivers.map(function (d) {
          return '<tr><td>' + escapeHtml(d.name) + activeTag(d.active) +
            (d.vehicle_name ? '<br><span class="muted small">' + escapeHtml(d.vehicle_name) + '</span>' : '') + '</td>' +
            '<td>' + (d.on_duty ? 'On duty' : 'Off') + '</td>' +
            '<td>' + fmtNum(d.accepted) + '</td><td>' + fmtNum(d.completed) + '</td>' +
            '<td>' + fmtNum(d.cancelled) + '</td><td>' + fmtNum(d.total_km) + '</td>' +
            '<td>' + fmtDuration(d.avg_response_seconds) + '</td><td>' + fmtDuration(d.avg_delivery_seconds) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    html += '</div>';

    // --- Recent jobs (p_status applies here only) ---
    html += '<div class="report-block"><h4 class="report-h">Recent jobs' +
      (state.status ? ' · ' + escapeHtml(STATUS_LABELS[state.status] || state.status) : '') + '</h4>';
    if (!recent.length) {
      html += '<div class="empty-state">No matching jobs.</div>';
    } else {
      html += '<div class="table-scroll"><table class="report-table"><thead><tr>' +
        '<th>When</th><th>Status</th><th>From</th><th>Driver</th><th>Vehicle</th><th>KM</th><th>Duration</th>' +
        '</tr></thead><tbody>' +
        recent.map(function (j) {
          var km = (j.start_km != null && j.end_km != null) ? (j.end_km - j.start_km) : null;
          return '<tr><td>' + escapeHtml(recentWhen(j)) + '</td>' +
            '<td>' + statusBadge(j.status) + '</td>' +
            '<td>' + escapeHtml(dash(j.origin)) + '</td>' +
            '<td>' + escapeHtml(dash(j.driver_name)) + '</td>' +
            '<td>' + escapeHtml(dash(j.vehicle)) + '</td>' +
            '<td>' + (km == null ? '—' : escapeHtml(km)) + '</td>' +
            '<td>' + fmtDuration(j.duration_seconds) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    html += '</div>';

    bodyEl.innerHTML = html;
  }

  function nowBadge(label, n) {
    var v = (n === null || n === undefined) ? 0 : n;
    return '<span class="now-chip"><span class="now-n">' + escapeHtml(v) + '</span> ' + escapeHtml(label) + '</span>';
  }

  // ---------- boot ----------
  (async function boot() {
    await loadTimezone();
    await loadOptions();
    run(); // default range: Today
  })();
}
