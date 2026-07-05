// Manager dashboard: pending requests (assign or cancel) and active jobs.
// RLS limits everything to the manager's own company. The database
// triggers stamp accepted_at/cancelled_at and flip vehicle status —
// the frontend only sets the new request status and assignment.

function initManagerPage(ctx) {
  var pendingEl = document.getElementById('pendingList');
  var activeEl = document.getElementById('activeList');
  var busyDriverIds = [];

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
      var outletName = r.outlets && r.outlets.name;
      return requestCardHtml(r, {
        topLine: outletName ? '🏬 ' + escapeHtml(outletName) : '',
        actionsHtml:
          '<button class="btn btn-primary" type="button" data-action="assign">Assign</button>' +
          '<button class="btn btn-outline" type="button" data-action="cancel">Cancel Request</button>',
      });
    }).join('');
  }

  async function loadActive() {
    var res = await window.sb
      .from('vehicle_requests')
      .select('id, status, pickup_location, dropoff_location, customer_name, customer_contact, created_at, accepted_at, started_at, driver_id, vehicle_id, outlets(name), drivers(name), vehicles(vehicle_name, plate_number)')
      .in('status', ['accepted', 'in_progress'])
      .order('created_at', { ascending: true });

    if (res.error) {
      activeEl.innerHTML = '<div class="empty-state">Could not load jobs. Please refresh.</div>';
      return;
    }

    busyDriverIds = res.data.map(function (r) { return r.driver_id; }).filter(Boolean);

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
      var outletName = r.outlets && r.outlets.name;
      return requestCardHtml(r, {
        topLine: outletName ? '🏬 ' + escapeHtml(outletName) : '',
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
      .select('id, status, pickup_location, dropoff_location, customer_name, customer_contact, notes, cancellation_reason, created_at, accepted_at, started_at, completed_at, cancelled_at, driver_id, vehicle_id, outlets(name), drivers(name), vehicles(vehicle_name, plate_number)')
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
      var outletName = r.outlets && r.outlets.name;
      return requestCardHtml(r, {
        topLine: outletName ? '🏬 ' + escapeHtml(outletName) : '',
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
  var map = null;
  var markersLayer = null;
  var mapFitted = false;

  function vehicleCardHtml(v) {
    var fresh = locationFreshness(v.last_updated);
    return '<div class="card">' +
      '<div class="request-top"><strong>' + escapeHtml(v.vehicle_name) + '</strong>' +
        statusBadge(v.status) + '</div>' +
      '<div class="meta">🔖 ' + escapeHtml(v.plate_number) + '</div>' +
      '<div class="meta">👤 ' + (v.drivers ? escapeHtml(v.drivers.name) : 'No driver assigned') + '</div>' +
      '<div class="meta">🕐 ' + (v.last_updated ? 'Updated ' + escapeHtml(fmtTime(v.last_updated)) : 'No location yet') + '</div>' +
      '<span class="chip fresh-' + fresh.cls + '">' + escapeHtml(fresh.label) + '</span>' +
    '</div>';
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
    if (!map) {
      map = L.map('vehicleMap');
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(map);
      markersLayer = L.layerGroup().addTo(map);
      map.setView([3.139, 101.6869], 11);
    }
    markersLayer.clearLayers();

    var located = vehicles.filter(function (v) {
      return v.last_lat != null && v.last_lng != null;
    });
    if (!located.length) {
      emptyEl.textContent = 'No vehicle locations yet.';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    var bounds = [];
    located.forEach(function (v) {
      var fresh = locationFreshness(v.last_updated);
      var popup = '<strong>' + escapeHtml(v.vehicle_name) + '</strong> · ' +
        escapeHtml(v.plate_number) + '<br>' +
        'Status: ' + escapeHtml(STATUS_LABELS[v.status] || v.status) + '<br>' +
        (v.drivers ? 'Driver: ' + escapeHtml(v.drivers.name) + '<br>' : '') +
        'Updated: ' + escapeHtml(fmtTime(v.last_updated)) + ' (' + escapeHtml(fresh.label) + ')';
      markersLayer.addLayer(L.marker([v.last_lat, v.last_lng]).bindPopup(popup));
      bounds.push([v.last_lat, v.last_lng]);
    });
    if (!mapFitted) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
      mapFitted = true;
    }
  }

  async function loadVehicles() {
    var res = await window.sb
      .from('vehicles')
      .select('id, vehicle_name, plate_number, status, last_lat, last_lng, last_updated, drivers(name)')
      .eq('active', true)
      .order('vehicle_name', { ascending: true });

    if (res.error) {
      vehiclesEl.innerHTML = '<div class="empty-state">Could not load vehicles. Please refresh.</div>';
      return;
    }

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

    var vehiclesRes = await window.sb
      .from('vehicles')
      .select('id, vehicle_name, plate_number')
      .eq('status', 'available')
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

    var vehicles = vehiclesRes.data;
    // Drivers already on an active job cannot take another one.
    var drivers = driversRes.data.filter(function (d) {
      return busyDriverIds.indexOf(d.id) === -1;
    });

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
      return '<option value="' + escapeHtml(v.id) + '">' +
        escapeHtml(v.vehicle_name) + ' · ' + escapeHtml(v.plate_number) + '</option>';
    }).join('');
    var driverOptions = drivers.map(function (d) {
      return '<option value="' + escapeHtml(d.id) + '">' + escapeHtml(d.name) + '</option>';
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
    showFlash('Request assigned successfully.', 'success');
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

  // Light polling keeps the overview fresh without realtime complexity.
  setInterval(loadVehicles, 60000);
  loadAll();
}
