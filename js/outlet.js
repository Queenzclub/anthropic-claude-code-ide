// Outlet dashboard: create vehicle requests and track active ones.
// Data access is enforced by RLS — outlet users can only insert
// pending requests for their own outlet and read their outlet's rows.

function initOutletPage(ctx) {
  var profile = ctx.profile;
  var form = document.getElementById('requestForm');
  var listEl = document.getElementById('requestList');
  var submitBtn = document.getElementById('submitRequestBtn');

  // An outlet account must be linked to an outlet by the admin.
  if (!profile.outlet_id) {
    form.querySelectorAll('input, textarea, button').forEach(function (el) { el.disabled = true; });
    listEl.innerHTML = '<div class="empty-state">Your account is not linked to an outlet yet. Please contact your admin.</div>';
    return;
  }

  function val(id) { return document.getElementById(id).value.trim(); }

  // ---------- Delivery tracking map (own active deliveries only) ----------
  // RLS migration 8 lets an outlet read a vehicle row only while it is on
  // an active job for their own outlet — so this only ever shows the van
  // bringing their own delivery.
  var map = null;
  var markersLayer = null;

  // Outlet-facing tracking state for a vehicle on our own delivery.
  // "Waiting for driver location" until the driver shares a point,
  // then "Live" (<= 5 min) or "Old location" after that.
  function outletTrackState(v) {
    if (!v || v.last_lat == null || v.last_lng == null || !v.last_updated) {
      return { located: false, label: 'Waiting for driver location', cls: 'none' };
    }
    var mins = (Date.now() - new Date(v.last_updated).getTime()) / 60000;
    if (mins <= 5) return { located: true, label: 'Live', cls: 'live' };
    return { located: true, label: 'Old location', cls: 'old' };
  }

  async function loadTrackedVehicles() {
    var ids = [];
    (window.__activeRequests || []).forEach(function (r) {
      if (r.vehicle_id && (r.status === 'accepted' || r.status === 'in_progress')) {
        if (ids.indexOf(r.vehicle_id) === -1) ids.push(r.vehicle_id);
      }
    });
    if (!ids.length) return {};
    var res = await window.sb
      .from('vehicles')
      .select('id, vehicle_name, plate_number, last_lat, last_lng, last_updated')
      .in('id', ids);
    var byId = {};
    if (!res.error && res.data) res.data.forEach(function (v) { byId[v.id] = v; });
    return byId;
  }

  function renderTrackMap(vehicles) {
    var mapEl = document.getElementById('trackMap');
    var emptyEl = document.getElementById('trackEmpty');
    var located = vehicles.filter(function (v) { return v && v.last_lat != null && v.last_lng != null; });

    if (!vehicles.length) {
      if (mapEl) mapEl.classList.add('hidden');
      emptyEl.textContent = 'No vehicle to track yet. A map appears here when a driver is on the way for one of your active requests.';
      emptyEl.classList.remove('hidden');
      return;
    }
    if (!located.length) {
      if (mapEl) mapEl.classList.add('hidden');
      emptyEl.textContent = 'Waiting for driver location. The map appears once the driver turns on location sharing.';
      emptyEl.classList.remove('hidden');
      return;
    }
    if (!window.L) {
      if (mapEl) mapEl.classList.add('hidden');
      emptyEl.textContent = 'Map could not be loaded.';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    if (mapEl) mapEl.classList.remove('hidden');

    if (!map) {
      map = L.map('trackMap');
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
      }).addTo(map);
      markersLayer = L.layerGroup().addTo(map);
      map.setView([3.139, 101.6869], 12);
    }
    markersLayer.clearLayers();
    var bounds = [];
    located.forEach(function (v) {
      var fresh = outletTrackState(v);
      var popup = '<strong>' + escapeHtml(v.vehicle_name) + '</strong> · ' + escapeHtml(v.plate_number) +
        '<br>Updated: ' + escapeHtml(fmtTime(v.last_updated)) + ' (' + escapeHtml(fresh.label) + ')';
      markersLayer.addLayer(L.marker([v.last_lat, v.last_lng]).bindPopup(popup));
      bounds.push([v.last_lat, v.last_lng]);
    });
    map.invalidateSize();
    if (bounds.length === 1) map.setView(bounds[0], 14);
    else map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
  }

  // Count of this outlet's deliveries completed since midnight (its own
  // query so it can run in parallel with the vehicle-tracking fetch).
  async function countCompletedToday() {
    var doneRes = await window.sb
      .from('vehicle_requests')
      .select('id')
      .eq('outlet_id', profile.outlet_id)
      .eq('status', 'completed')
      .gte('updated_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString());
    return (!doneRes.error && doneRes.data) ? doneRes.data.length : 0;
  }

  // Today summary cards. completedToday is fetched by the caller so this
  // stays synchronous and does not add another serial round-trip.
  function updateSummary(active, vehiclesById, completedToday) {
    var pending = active.filter(function (r) { return r.status === 'pending'; }).length;
    var moving = active.filter(function (r) { return r.status === 'accepted' || r.status === 'in_progress'; }).length;
    var onTheWay = active.filter(function (r) {
      return r.vehicle_id && vehiclesById[r.vehicle_id];
    }).length;

    var host = document.getElementById('summaryStats');
    var tiles = [
      [moving, 'Active Deliveries'],
      [pending, 'Waiting Pickup'],
      [onTheWay, 'On the Way'],
      [completedToday, 'Completed Today'],
    ];
    host.innerHTML = tiles.map(function (t) {
      return '<div class="stat"><div class="stat-num">' + t[0] + '</div>' +
        '<div class="stat-label">' + t[1] + '</div></div>';
    }).join('');
  }

  async function loadRequests() {
    var res = await window.sb
      .from('vehicle_requests')
      .select('id, status, pickup_location, dropoff_location, customer_name, customer_contact, notes, driver_id, vehicle_id, created_at')
      .eq('outlet_id', profile.outlet_id)
      .in('status', ['pending', 'accepted', 'in_progress'])
      .order('created_at', { ascending: false });

    if (res.error) {
      listEl.innerHTML = '<div class="empty-state">Could not load requests. Please refresh.</div>';
      return;
    }
    window.__activeRequests = res.data;
    if (!res.data.length) {
      listEl.innerHTML = '<div class="empty-state">No active deliveries. Tap Request Vehicle to start one.</div>';
      renderTrackMap([]);
      updateSummary([], {}, 0);
      return;
    }

    // Trackable vehicles (RLS returns only our active-delivery vans) and
    // today's completed count run in parallel — no serial round-trips.
    var results = await Promise.all([loadTrackedVehicles(), countCompletedToday()]);
    var vehiclesById = results[0];
    var completedToday = results[1];

    listEl.innerHTML = res.data.map(function (r) {
      // Outlet users see THAT a driver is assigned (not who), and — for
      // their own active delivery — the assigned van and its freshness.
      var chips = '';
      if (r.driver_id) chips += '<span class="chip">👤 Driver assigned</span>';
      var v = r.vehicle_id && vehiclesById[r.vehicle_id];
      if (v) {
        var fresh = outletTrackState(v);
        chips += '<span class="chip">🚐 ' + escapeHtml(v.vehicle_name) + ' · ' + escapeHtml(v.plate_number) + '</span>';
        chips += '<span class="chip fresh-' + fresh.cls + '">' + escapeHtml(fresh.label) + '</span>';
        chips += '<div class="meta">📍 ' + (fresh.located
          ? 'Location updated ' + escapeHtml(fmtTime(v.last_updated))
          : 'Waiting for driver location') + '</div>';
      } else if (r.vehicle_id) {
        chips += '<span class="chip">🚐 Vehicle assigned</span>';
      } else if (r.status === 'accepted' || r.status === 'in_progress') {
        chips += '<span class="chip">⏳ Waiting for a vehicle to be assigned</span>';
      }
      return requestCardHtml(r, { extraHtml: chips });
    }).join('');

    var trackable = Object.keys(vehiclesById).map(function (k) { return vehiclesById[k]; });
    renderTrackMap(trackable);
    updateSummary(res.data, vehiclesById, completedToday);
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();

    var pickup = val('pickup');
    var dropoff = val('dropoff');
    if (!pickup || !dropoff) {
      showFlash('Please fill in pickup and drop-off locations.', 'error');
      return;
    }

    submitBtn.disabled = true;
    // Outlet requests are OPEN dispatch: sent to all on-duty drivers,
    // first one to accept takes it. (Outlets don't pick vehicles.)
    var res = await window.sb.from('vehicle_requests').insert({
      company_id: profile.company_id,
      outlet_id: profile.outlet_id,
      requested_by: profile.user_id,
      status: 'pending',
      dispatch_mode: 'open',
      pickup_location: pickup,
      dropoff_location: dropoff,
      customer_name: val('customerName') || null,
      customer_contact: val('customerContact') || null,
      notes: val('notes') || null,
    });
    submitBtn.disabled = false;

    if (res.error) {
      showFlash('Could not create request. Please try again.', 'error');
      return;
    }

    form.reset();
    document.getElementById('requestFormHost').classList.add('hidden');
    showFlash('Request sent to available drivers.', 'success');
    loadRequests();
  });

  // Collapsible request form.
  var formHost = document.getElementById('requestFormHost');
  document.getElementById('toggleRequestBtn').addEventListener('click', function () {
    formHost.classList.toggle('hidden');
    if (!formHost.classList.contains('hidden')) document.getElementById('pickup').focus();
  });
  document.getElementById('cancelRequestBtn').addEventListener('click', function () {
    form.reset();
    formHost.classList.add('hidden');
  });

  // Request history: this outlet's completed and cancelled requests.
  // Same RLS as the active list — only their own outlet's rows come
  // back. Driver/vehicle names stay private from outlets, so history
  // shows "assigned" chips like the active list does.
  var historyEl = document.getElementById('historyList');

  async function loadHistory() {
    var res = await window.sb
      .from('vehicle_requests')
      .select('id, status, pickup_location, dropoff_location, customer_name, customer_contact, cancellation_reason, driver_id, vehicle_id, created_at, completed_at, cancelled_at')
      .eq('outlet_id', profile.outlet_id)
      .in('status', ['completed', 'cancelled'])
      .order('updated_at', { ascending: false })
      .limit(20);

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
      if (r.driver_id) extra += '<span class="chip">👤 Driver assigned</span>';
      if (r.vehicle_id) extra += '<span class="chip">🚐 Vehicle assigned</span>';
      if (r.cancellation_reason) {
        extra += '<div class="meta">💬 Reason: ' + escapeHtml(r.cancellation_reason) + '</div>';
      }
      var closed = r.completed_at
        ? '✅ Completed ' + fmtTime(r.completed_at)
        : (r.cancelled_at ? '🚫 Cancelled ' + fmtTime(r.cancelled_at) : '');
      if (closed) extra += '<div class="meta">' + escapeHtml(closed) + '</div>';
      return requestCardHtml(r, { extraHtml: extra });
    }).join('');
  }

  document.getElementById('refreshRequests').addEventListener('click', function () {
    loadRequests();
    loadHistory();
  });
  loadRequests();
  loadHistory();

  // Live notification when one of this outlet's own deliveries completes.
  if (typeof initOutletNotifications === 'function') {
    initOutletNotifications(profile, function () {
      loadHistory();
      loadRequests();
    });
    initAlertsButton('enableAlerts');
  }
}
