// Manager dashboard: pending requests (assign or cancel) and active jobs.
// RLS limits everything to the manager's own company. The database
// triggers stamp accepted_at/cancelled_at and flip vehicle status —
// the frontend only sets the new request status and assignment.

function initManagerPage(ctx) {
  var pendingEl = document.getElementById('pendingList');
  var activeEl = document.getElementById('activeList');
  // Active-job counts per driver/vehicle (multi-job queues). Refreshed
  // with the active list; used for card chips, assign-panel labels and
  // the 3+ jobs soft warning.
  var jobCounts = { driver: {}, vehicle: {} };

  function driverJobs(id) { return (id && jobCounts.driver[id]) || 0; }
  function vehicleJobs(id) { return (id && jobCounts.vehicle[id]) || 0; }
  function queueWarning(prefix, n) {
    return prefix + ' already has ' + n + ' active job' + (n === 1 ? '' : 's') +
      '. This request was added to their queue.';
  }

  // Where a request came from: the outlet's name, or a manager.
  function originLine(r) {
    var outletName = r.outlets && r.outlets.name;
    return outletName ? '🏬 ' + escapeHtml(outletName) : '🧑‍💼 Manager request';
  }

  // ---------- Create Request (manual dispatch) ----------
  // Managers can start a delivery from ANY pickup/drop-off place —
  // outlet_id stays null and RLS keeps such requests invisible to
  // outlets. "Send to" picks open dispatch (default) or one specific
  // driver; manager assignment on pending cards stays the override.
  var dispatchList = [];
  var mSendTo = document.getElementById('mSendTo');
  var createHost = document.getElementById('createFormHost');
  var pins = { pickup: null, dropoff: null, mode: null, map: null, markers: {} };

  async function loadDispatchList() {
    if (!mSendTo || !window.sb.rpc) return;
    var res = await window.sb.rpc('dispatchable_drivers');
    if (res.error || !res.data) return;
    dispatchList = res.data;
    var current = mSendTo.value;
    // Managers see ALL active drivers, with duty visible in the label.
    var options = '<option value="">🚚 Any available driver</option>';
    dispatchList.forEach(function (d) {
      var label = (d.on_duty ? '🟢 ' : '⚪ ') + d.driver_name +
        (d.vehicle_name ? ' — ' + d.vehicle_name : '') +
        (d.on_duty ? '' : ' (off duty)');
      options += '<option value="' + escapeHtml(d.driver_id) + '">' + escapeHtml(label) + '</option>';
    });
    mSendTo.innerHTML = options;
    mSendTo.value = current || '';
  }

  function renderPinStatus() {
    var parts = [];
    if (pins.pickup) parts.push('📍 pickup pinned');
    if (pins.dropoff) parts.push('🏁 drop-off pinned');
    if (pins.mode) parts.push('tap the map to place the ' + pins.mode + ' pin');
    document.getElementById('pinStatus').textContent = parts.join(' · ');
  }

  function ensurePinMap() {
    var el = document.getElementById('pinMap');
    el.classList.remove('hidden');
    if (pins.map || !window.L) return;
    pins.map = L.map('pinMap');
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
    }).addTo(pins.map);
    pins.map.setView([3.139, 101.6869], 12);
    pins.map.on('click', function (e) {
      if (!pins.mode) return;
      var kind = pins.mode;
      pins[kind] = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (pins.markers[kind]) pins.markers[kind].setLatLng(e.latlng);
      else pins.markers[kind] = L.marker(e.latlng).addTo(pins.map)
        .bindPopup(kind === 'pickup' ? '📍 Pickup' : '🏁 Drop-off');
      pins.mode = null;
      renderPinStatus();
    });
    setTimeout(function () { pins.map.invalidateSize(); }, 50);
  }

  function armPin(kind) {
    ensurePinMap();
    pins.mode = kind;
    renderPinStatus();
    if (pins.map) setTimeout(function () { pins.map.invalidateSize(); }, 50);
  }

  function resetCreateForm() {
    document.getElementById('createForm').reset();
    pins.pickup = null;
    pins.dropoff = null;
    pins.mode = null;
    Object.keys(pins.markers).forEach(function (k) {
      if (pins.map) pins.map.removeLayer(pins.markers[k]);
    });
    pins.markers = {};
    renderPinStatus();
  }

  async function submitCreate(e) {
    e.preventDefault();
    var pickup = document.getElementById('mPickup').value.trim();
    var dropoff = document.getElementById('mDropoff').value.trim();
    if (!pickup || !dropoff) {
      showFlash('Please fill in pickup and drop-off locations.', 'error');
      return;
    }
    var btn = document.getElementById('createSubmitBtn');
    btn.disabled = true;
    var targetId = mSendTo ? mSendTo.value : '';
    var target = null;
    for (var i = 0; i < dispatchList.length; i++) {
      if (dispatchList[i].driver_id === targetId) { target = dispatchList[i]; break; }
    }
    var row = {
      company_id: ctx.profile.company_id,
      outlet_id: null,
      requested_by: ctx.profile.user_id,
      status: 'pending',
      dispatch_mode: target ? 'specific' : 'open',
      pickup_location: pickup,
      dropoff_location: dropoff,
      customer_name: document.getElementById('mCustomerName').value.trim() || null,
      customer_contact: document.getElementById('mCustomerContact').value.trim() || null,
      notes: document.getElementById('mNotes').value.trim() || null,
      pickup_lat: pins.pickup ? pins.pickup.lat : null,
      pickup_lng: pins.pickup ? pins.pickup.lng : null,
      dropoff_lat: pins.dropoff ? pins.dropoff.lat : null,
      dropoff_lng: pins.dropoff ? pins.dropoff.lng : null,
    };
    if (target) {
      row.target_driver_id = target.driver_id;
      row.target_vehicle_id = target.vehicle_id || null;
    }
    var res = await window.sb.from('vehicle_requests').insert(row);
    btn.disabled = false;
    if (res.error) {
      showFlash('Could not create request. Please try again.', 'error');
      return;
    }
    resetCreateForm();
    createHost.classList.add('hidden');
    if (target && driverJobs(target.driver_id) >= 3) {
      showFlash('Request sent to ' + target.driver_name + '. ' +
        queueWarning('This driver', driverJobs(target.driver_id)), 'warn');
    } else {
      showFlash(target
        ? 'Request sent to ' + target.driver_name + '.'
        : 'Request sent to available drivers.', 'success');
    }
    loadAll();
  }

  document.getElementById('toggleCreateBtn').addEventListener('click', function () {
    createHost.classList.toggle('hidden');
    if (!createHost.classList.contains('hidden')) {
      loadDispatchList();
      document.getElementById('mPickup').focus();
    }
  });
  document.getElementById('createCancelBtn').addEventListener('click', function () {
    resetCreateForm();
    createHost.classList.add('hidden');
  });
  document.getElementById('pinPickupBtn').addEventListener('click', function () { armPin('pickup'); });
  document.getElementById('pinDropoffBtn').addEventListener('click', function () { armPin('dropoff'); });
  document.getElementById('createForm').addEventListener('submit', submitCreate);

  async function loadPending() {
    var res = await window.sb
      .from('vehicle_requests')
      .select('id, status, pickup_location, dropoff_location, customer_name, customer_contact, notes, created_at, outlets(name)')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (res.error) {
      pendingEl.innerHTML = '<div class="empty-state">Could not load requests. Please refresh.</div>';
      return;
    }
    if (!res.data.length) {
      pendingEl.innerHTML = '<div class="empty-state">No pending requests.</div>';
      return;
    }
    pendingEl.innerHTML = res.data.map(function (r) {
      return requestCardHtml(r, {
        topLine: originLine(r),
        actionsHtml:
          '<button class="btn btn-primary" type="button" data-action="assign">Assign</button>' +
          '<button class="btn btn-outline" type="button" data-action="cancel">Cancel Request</button>',
      });
    }).join('');
  }

  async function loadActive() {
    var res = await window.sb
      .from('vehicle_requests')
      .select('id, status, pickup_location, dropoff_location, customer_name, customer_contact, created_at, accepted_at, started_at, driver_id, vehicle_id, outlets(name), drivers!driver_id(name), vehicles!vehicle_id(vehicle_name, plate_number)')
      .in('status', ['accepted', 'in_progress'])
      .order('created_at', { ascending: true });

    if (res.error) {
      activeEl.innerHTML = '<div class="empty-state">Could not load jobs. Please refresh.</div>';
      return;
    }

    jobCounts = { driver: {}, vehicle: {} };
    res.data.forEach(function (r) {
      if (r.driver_id) jobCounts.driver[r.driver_id] = (jobCounts.driver[r.driver_id] || 0) + 1;
      if (r.vehicle_id) jobCounts.vehicle[r.vehicle_id] = (jobCounts.vehicle[r.vehicle_id] || 0) + 1;
    });

    if (!res.data.length) {
      activeEl.innerHTML = '<div class="empty-state">No active jobs.</div>';
      return;
    }
    activeEl.innerHTML = res.data.map(function (r) {
      var chips = '';
      if (r.drivers && r.drivers.name) {
        chips += '<span class="chip">👤 ' + escapeHtml(r.drivers.name) + '</span>';
      }
      if (r.vehicles) {
        chips += '<span class="chip">🚐 ' + escapeHtml(r.vehicles.vehicle_name) +
                 ' · ' + escapeHtml(r.vehicles.plate_number) + '</span>';
      }
      return requestCardHtml(r, {
        topLine: originLine(r),
        extraHtml: chips + timesHtml(r),
      });
    }).join('');
  }

  function loadAll() { loadPending(); loadActive(); loadVehicles(); loadSummary(); loadHistory(); }

  // ---------- Today summary + job history ----------
  // History reads use the same staff RLS as everything else: the
  // database only returns this company's rows. Filters are simple
  // time/status narrowing on top; closed jobs never change, so
  // updated_at is effectively the close time.

  var HISTORY_LIMIT = 30;
  var historyFilter = { range: 'today', status: 'all' };
  var summaryEl = document.getElementById('summaryStats');
  var historyEl = document.getElementById('historyList');

  function rangeStartIso(range) {
    if (range === 'today') {
      var d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
    if (range === '7d') return new Date(Date.now() - 7 * 86400000).toISOString();
    return null; // 'all recent' — just the limit applies
  }

  async function loadSummary() {
    var closedRes = await window.sb
      .from('vehicle_requests')
      .select('id, status')
      .in('status', ['completed', 'cancelled'])
      .gte('updated_at', rangeStartIso('today'));
    var activeRes = await window.sb
      .from('vehicle_requests')
      .select('id')
      .in('status', ['accepted', 'in_progress']);
    var availRes = await window.sb
      .from('vehicles')
      .select('id')
      .eq('status', 'available')
      .eq('active', true);

    if (closedRes.error || activeRes.error || availRes.error) {
      summaryEl.innerHTML = '<div class="empty-state">Could not load summary.</div>';
      return;
    }
    var completedToday = closedRes.data.filter(function (r) { return r.status === 'completed'; }).length;
    var cancelledToday = closedRes.data.length - completedToday;
    var cells = [
      [completedToday, 'Completed Today'],
      [cancelledToday, 'Cancelled Today'],
      [activeRes.data.length, 'Active Jobs'],
      [availRes.data.length, 'Available Vehicles'],
    ];
    summaryEl.innerHTML = cells.map(function (c) {
      return '<div class="stat"><div class="stat-num">' + c[0] + '</div>' +
        '<div class="stat-label">' + c[1] + '</div></div>';
    }).join('');
  }

  async function loadHistory() {
    var statuses = historyFilter.status === 'all'
      ? ['completed', 'cancelled']
      : [historyFilter.status];

    var q = window.sb
      .from('vehicle_requests')
      .select('id, status, pickup_location, dropoff_location, customer_name, customer_contact, notes, cancellation_reason, created_at, accepted_at, started_at, completed_at, cancelled_at, driver_id, vehicle_id, outlets(name), drivers!driver_id(name), vehicles!vehicle_id(vehicle_name, plate_number)')
      .in('status', statuses);
    var start = rangeStartIso(historyFilter.range);
    if (start) q = q.gte('updated_at', start);
    var res = await q.order('updated_at', { ascending: false }).limit(HISTORY_LIMIT);

    if (res.error) {
      historyEl.innerHTML = '<div class="empty-state">Could not load history. Please refresh.</div>';
      return;
    }
    if (!res.data.length) {
      historyEl.innerHTML = '<div class="empty-state">No recent history.</div>';
      return;
    }
    historyEl.innerHTML = res.data.map(function (r) {
      var extra = '';
      if (r.drivers && r.drivers.name) {
        extra += '<span class="chip">👤 ' + escapeHtml(r.drivers.name) + '</span>';
      }
      if (r.vehicles) {
        extra += '<span class="chip">🚐 ' + escapeHtml(r.vehicles.vehicle_name) +
                 ' · ' + escapeHtml(r.vehicles.plate_number) + '</span>';
      }
      if (r.cancellation_reason) {
        extra += '<div class="meta">💬 Reason: ' + escapeHtml(r.cancellation_reason) + '</div>';
      }
      extra += timesHtml(r);
      return requestCardHtml(r, {
        topLine: originLine(r),
        extraHtml: extra,
      });
    }).join('');
  }

  // ---------- Vehicle status overview + map ----------
  // Vehicles come pre-scoped to the manager's company by RLS. The map
  // only shows vehicles with a stored location; freshness labels are
  // display-only (the stored status is never changed from here).

  var statsEl = document.getElementById('vehicleStats');
  var vehiclesEl = document.getElementById('vehicleList');
  var liveMap = createLiveVehicleMap('vehicleMap');
  var vehicleCache = {};  // id -> latest row (for driver names on live moves)

  function vehicleCardHtml(v) {
    var fresh = locationFreshness(v.last_updated);
    var duty = '';
    if (v.drivers) {
      duty = v.drivers.on_duty
        ? '<span class="chip fresh-live">🟢 On Duty</span>'
        : '<span class="chip fresh-offline">⚪ Off Duty</span>';
    }
    var jobs = vehicleJobs(v.id);
    var jobsChip = jobs
      ? '<span class="chip">📦 ' + jobs + ' active job' + (jobs === 1 ? '' : 's') + '</span>'
      : '';
    return '<div class="card">' +
      '<div class="request-top"><strong>' + escapeHtml(v.vehicle_name) + '</strong>' +
        statusBadge(v.status) + '</div>' +
      '<div class="meta">🔖 ' + escapeHtml(v.plate_number) + '</div>' +
      '<div class="meta">👤 ' + (v.drivers ? escapeHtml(v.drivers.name) : 'No driver assigned') + '</div>' +
      '<div class="meta">🕐 ' + (v.last_updated ? 'Updated ' + escapeHtml(fmtTime(v.last_updated)) : 'No location yet') + '</div>' +
      '<span class="chip fresh-' + fresh.cls + '">' + escapeHtml(fresh.label) + '</span>' + duty + jobsChip +
    '</div>';
  }

  function vehiclePopup(v) {
    var html = vehiclePopupHtml(v, { driverName: v.drivers && v.drivers.name });
    var jobs = vehicleJobs(v.id);
    if (jobs) html += '<br>📦 ' + jobs + ' active job' + (jobs === 1 ? '' : 's');
    return html;
  }

  function renderMap(vehicles) {
    var mapEl = document.getElementById('vehicleMap');
    var emptyEl = document.getElementById('mapEmpty');
    if (!window.L) {
      mapEl.classList.add('hidden');
      emptyEl.textContent = 'Map could not be loaded.';
      emptyEl.classList.remove('hidden');
      return;
    }

    var located = vehicles.filter(function (v) {
      return v.last_lat != null && v.last_lng != null;
    });
    // Incremental: markers move in place; zoom/pan kept after first fit.
    var shown = liveMap.sync(located, vehiclePopup);
    if (!shown) {
      emptyEl.textContent = 'No vehicle locations yet.';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
  }

  // Live position event for a company vehicle: move its marker in place.
  // The realtime row has no joined driver name, so it is merged from the
  // last full load. RLS scopes events to this company only.
  function onVehicleMove(v) {
    if (!window.L) return;
    var known = vehicleCache[v.id];
    if (known && known.drivers) v.drivers = known.drivers;
    vehicleCache[v.id] = v;
    if (v.last_lat == null || v.last_lng == null) return;
    document.getElementById('mapEmpty').classList.add('hidden');
    liveMap.move(v, vehiclePopup(v));
  }

  async function loadVehicles() {
    var res = await window.sb
      .from('vehicles')
      .select('id, vehicle_name, plate_number, status, last_lat, last_lng, last_updated, drivers(name, on_duty)')
      .eq('active', true)
      .order('vehicle_name', { ascending: true });

    if (res.error) {
      vehiclesEl.innerHTML = '<div class="empty-state">Could not load vehicles. Please refresh.</div>';
      return;
    }
    vehicleCache = {};
    res.data.forEach(function (v) { vehicleCache[v.id] = v; });

    var counts = { available: 0, busy: 0, offline: 0, maintenance: 0 };
    res.data.forEach(function (v) {
      if (counts[v.status] != null) counts[v.status] += 1;
    });
    statsEl.innerHTML = Object.keys(counts).map(function (k) {
      return '<div class="stat"><div class="stat-num">' + counts[k] + '</div>' +
        '<div class="stat-label">' + STATUS_LABELS[k] + '</div></div>';
    }).join('');

    vehiclesEl.innerHTML = res.data.length
      ? res.data.map(vehicleCardHtml).join('')
      : '<div class="empty-state">No vehicles yet.</div>';

    renderMap(res.data);
  }

  function closePanels() {
    pendingEl.querySelectorAll('[data-panel]').forEach(function (p) { p.remove(); });
  }

  async function openAssignPanel(card) {
    closePanels();
    card.insertAdjacentHTML('beforeend',
      '<div class="inline-panel" data-panel><p class="muted">Loading…</p></div>');
    var panel = card.querySelector('[data-panel]');

    // Multi-job queues: busy vehicles and drivers CAN take another job —
    // they are listed with their current job count. Maintenance stays out.
    var vehiclesRes = await window.sb
      .from('vehicles')
      .select('id, vehicle_name, plate_number, status')
      .eq('active', true)
      .order('vehicle_name', { ascending: true });
    var driversRes = await window.sb
      .from('drivers')
      .select('id, name')
      .eq('active', true)
      .order('name', { ascending: true });

    if (vehiclesRes.error || driversRes.error) {
      panel.innerHTML = '<p class="muted">Could not load vehicles and drivers. Please try again.</p>' +
        '<div class="request-actions"><button class="btn btn-outline" type="button" data-action="close-panel">Back</button></div>';
      return;
    }

    var vehicles = vehiclesRes.data.filter(function (v) { return v.status !== 'maintenance'; });
    var drivers = driversRes.data;

    var backBtn = '<button class="btn btn-outline" type="button" data-action="close-panel">Back</button>';
    if (!vehicles.length) {
      panel.innerHTML = '<p class="muted">No available vehicles found.</p>' +
        '<div class="request-actions">' + backBtn + '</div>';
      return;
    }
    if (!drivers.length) {
      panel.innerHTML = '<p class="muted">No available drivers found.</p>' +
        '<div class="request-actions">' + backBtn + '</div>';
      return;
    }

    var vehicleOptions = vehicles.map(function (v) {
      var jobs = vehicleJobs(v.id);
      return '<option value="' + escapeHtml(v.id) + '">' +
        escapeHtml(v.vehicle_name) + ' · ' + escapeHtml(v.plate_number) +
        (jobs ? ' (' + jobs + ' job' + (jobs === 1 ? '' : 's') + ')' : '') + '</option>';
    }).join('');
    var driverOptions = drivers.map(function (d) {
      var jobs = driverJobs(d.id);
      return '<option value="' + escapeHtml(d.id) + '">' + escapeHtml(d.name) +
        (jobs ? ' (' + jobs + ' job' + (jobs === 1 ? '' : 's') + ')' : '') + '</option>';
    }).join('');

    panel.innerHTML =
      '<div class="form-grid">' +
        '<div class="field"><label>Vehicle</label><select data-role="vehicle">' + vehicleOptions + '</select></div>' +
        '<div class="field"><label>Driver</label><select data-role="driver">' + driverOptions + '</select></div>' +
      '</div>' +
      '<div class="request-actions">' +
        '<button class="btn btn-primary" type="button" data-action="confirm-assign">Assign</button>' +
        backBtn +
      '</div>';
  }

  function openCancelPanel(card) {
    closePanels();
    card.insertAdjacentHTML('beforeend',
      '<div class="inline-panel" data-panel>' +
        '<div class="field"><label>Reason</label>' +
        '<input data-role="reason" placeholder="Why is this cancelled? (optional)"></div>' +
        '<div class="request-actions">' +
          '<button class="btn btn-danger" type="button" data-action="confirm-cancel">Cancel Request</button>' +
          '<button class="btn btn-outline" type="button" data-action="close-panel">Back</button>' +
        '</div>' +
      '</div>');
  }

  async function doAssign(id, vehicleId, driverId, btn) {
    if (!vehicleId || !driverId) {
      showFlash('Please choose a vehicle and a driver.', 'error');
      return;
    }
    btn.disabled = true;
    var res = await window.sb
      .from('vehicle_requests')
      .update({ status: 'accepted', vehicle_id: vehicleId, driver_id: driverId })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id');

    if (res.error) {
      btn.disabled = false;
      if (res.error.code === '23505') {
        showFlash('That vehicle or driver already has an active job.', 'error');
      } else {
        showFlash('Could not assign request. Please try again.', 'error');
      }
      return;
    }
    if (!res.data || !res.data.length) {
      showFlash('This request was already handled.', 'error');
      loadAll();
      return;
    }
    var jobsBefore = driverJobs(driverId);
    if (jobsBefore >= 3) {
      showFlash('Assigned. ' + queueWarning('This driver', jobsBefore), 'warn');
    } else {
      showFlash('Request assigned successfully.', 'success');
    }
    loadAll();
  }

  async function doCancel(id, reason, btn) {
    btn.disabled = true;
    var res = await window.sb
      .from('vehicle_requests')
      .update({ status: 'cancelled', cancellation_reason: reason || null })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id');

    if (res.error) {
      btn.disabled = false;
      showFlash('Could not cancel request. Please try again.', 'error');
      return;
    }
    if (!res.data || !res.data.length) {
      showFlash('This request was already handled.', 'error');
      loadAll();
      return;
    }
    showFlash('Request cancelled.', 'success');
    loadAll();
  }

  pendingEl.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var card = btn.closest('.request-card');
    var id = card.getAttribute('data-id');
    var action = btn.getAttribute('data-action');

    if (action === 'assign') openAssignPanel(card);
    else if (action === 'cancel') openCancelPanel(card);
    else if (action === 'close-panel') closePanels();
    else if (action === 'confirm-assign') {
      var vehicleSel = card.querySelector('[data-role="vehicle"]');
      var driverSel = card.querySelector('[data-role="driver"]');
      doAssign(id, vehicleSel && vehicleSel.value, driverSel && driverSel.value, btn);
    } else if (action === 'confirm-cancel') {
      var reasonInput = card.querySelector('[data-role="reason"]');
      doCancel(id, reasonInput ? reasonInput.value.trim() : '', btn);
    }
  });

  document.getElementById('refreshPending').addEventListener('click', loadAll);
  document.getElementById('refreshVehicles').addEventListener('click', loadVehicles);
  document.getElementById('refreshHistory').addEventListener('click', function () {
    loadSummary();
    loadHistory();
  });

  // One active button per filter group (time range / status).
  document.getElementById('historyFilters').addEventListener('click', function (e) {
    var btn = e.target.closest('.filter-btn');
    if (!btn) return;
    var group = btn.hasAttribute('data-range') ? 'range' : 'status';
    historyFilter[group] = btn.getAttribute('data-' + group);
    document.querySelectorAll('#historyFilters .filter-btn[data-' + group + ']').forEach(function (b) {
      b.classList.remove('active');
    });
    btn.classList.add('active');
    loadHistory();
  });

  // Live marker moves via realtime; 60s polling stays as the fallback
  // and keeps the status cards/counters fresh.
  if (typeof initVehicleLiveUpdates === 'function') {
    initVehicleLiveUpdates(ctx.profile, onVehicleMove);
  }
  setInterval(loadVehicles, 60000);
  loadAll();
}
