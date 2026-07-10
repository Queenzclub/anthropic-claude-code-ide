// Shared UI helpers for dashboard pages: escaping, formatting,
// status badges, request cards, and flash messages.

var STATUS_LABELS = {
  pending: 'Pending',
  accepted: 'Accepted',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  available: 'Available',
  busy: 'Busy',
  offline: 'Offline',
  maintenance: 'Maintenance',
  service_due: 'Service Due',
  in_service: 'In Service',
  damaged: 'Damaged',
};

// Service states that take a vehicle OUT of dispatch (Stage 3A). These
// mirror the database: the job->vehicle sync trigger never overwrites
// them, and the dispatch pickers hide vehicles in these states.
// 'service_due' is deliberately NOT here — it is advisory only, so a
// service-due vehicle stays dispatchable (shown with an amber badge).
var VEHICLE_UNAVAILABLE = ['maintenance', 'in_service', 'damaged'];

function vehicleDispatchable(status) {
  return VEHICLE_UNAVAILABLE.indexOf(status) === -1;
}

// Always escape user-entered text before putting it in HTML.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function statusBadge(status) {
  return '<span class="badge badge-' + escapeHtml(status) + '">' +
    escapeHtml(STATUS_LABELS[status] || status) + '</span>';
}

// One card for a vehicle request. opts:
//   topLine     — extra pre-escaped HTML line under the badge (e.g. outlet name)
//   extraHtml   — pre-escaped HTML after the details (e.g. assignment chips)
//   actionsHtml — pre-escaped HTML buttons at the bottom
function requestCardHtml(r, opts) {
  opts = opts || {};
  var html = '<article class="request-card" data-id="' + escapeHtml(r.id) + '">';
  html += '<div class="request-top">' + statusBadge(r.status) +
          '<span class="muted small">' + escapeHtml(fmtTime(r.created_at)) + '</span></div>';
  if (opts.topLine) html += '<div class="meta">' + opts.topLine + '</div>';
  html += '<div class="route"><div>📍 ' + escapeHtml(r.pickup_location) + '</div>' +
          '<div>🏁 ' + escapeHtml(r.dropoff_location) + '</div></div>';
  if (r.customer_name || r.customer_contact) {
    var customer = escapeHtml(r.customer_name || '');
    if (r.customer_contact) {
      customer += (customer ? ' · ' : '') + escapeHtml(r.customer_contact);
    }
    html += '<div class="meta">👤 ' + customer + '</div>';
  }
  if (r.notes) html += '<div class="meta">📝 ' + escapeHtml(r.notes) + '</div>';
  if (opts.extraHtml) html += '<div>' + opts.extraHtml + '</div>';
  if (opts.actionsHtml) html += '<div class="request-actions">' + opts.actionsHtml + '</div>';
  html += '</article>';
  return html;
}

// ---------- Navigation / map-link helpers (Stage 2C) ----------
// All navigation is handed off to the phone's map app via normal links —
// the app never does turn-by-turn itself.
function hasPin(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number' && !isNaN(lat) && !isNaN(lng);
}

// A Google Maps link to a single point: coordinates if pinned, else a
// text search on the typed location. null if we have neither.
function mapsPointUrl(lat, lng, text) {
  if (hasPin(lat, lng)) return 'https://www.google.com/maps/search/?api=1&query=' + lat + '%2C' + lng;
  if (text) return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(text);
  return null;
}

// A driving-route link (pickup -> drop-off). Only when BOTH are pinned.
function mapsRouteUrl(pLat, pLng, dLat, dLng) {
  if (!hasPin(pLat, pLng) || !hasPin(dLat, dLng)) return null;
  return 'https://www.google.com/maps/dir/?api=1&origin=' + pLat + '%2C' + pLng +
    '&destination=' + dLat + '%2C' + dLng + '&travelmode=driving';
}

// Distinct pickup (green P) vs drop-off (red D) markers.
function pinIcon(kind) {
  return L.divIcon({
    className: 'route-pin route-pin-' + kind,
    html: kind === 'pickup' ? 'P' : 'D',
    iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12],
  });
}

function vanDivIcon() {
  return L.divIcon({ className: 'van-marker', html: '🚐', iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16] });
}

// Builds a Leaflet map into mapElId showing whichever of pickup / drop-off
// pins exist (and optionally the driver's vehicle). Returns the map so the
// caller can remove() it before re-render. opts.full enables zoom controls.
function buildRouteMap(mapElId, job, opts) {
  opts = opts || {};
  if (!window.L || !document.getElementById(mapElId)) return null;
  var map = L.map(mapElId, { attributionControl: false, zoomControl: !!opts.full });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  var pts = [];
  if (hasPin(job.pickup_lat, job.pickup_lng)) {
    L.marker([job.pickup_lat, job.pickup_lng], { icon: pinIcon('pickup') }).addTo(map)
      .bindPopup('📍 Pickup' + (job.pickup_location ? '<br>' + escapeHtml(job.pickup_location) : ''));
    pts.push([job.pickup_lat, job.pickup_lng]);
  }
  if (hasPin(job.dropoff_lat, job.dropoff_lng)) {
    L.marker([job.dropoff_lat, job.dropoff_lng], { icon: pinIcon('dropoff') }).addTo(map)
      .bindPopup('🏁 Drop-off' + (job.dropoff_location ? '<br>' + escapeHtml(job.dropoff_location) : ''));
    pts.push([job.dropoff_lat, job.dropoff_lng]);
  }
  var v = opts.vehicle;
  if (v && hasPin(v.last_lat, v.last_lng)) {
    L.marker([v.last_lat, v.last_lng], { icon: vanDivIcon() }).addTo(map)
      .bindPopup('🚐 ' + escapeHtml(v.vehicle_name || 'Your vehicle'));
    pts.push([v.last_lat, v.last_lng]);
  }
  if (pts.length === 1) map.setView(pts[0], 15);
  else if (pts.length > 1) map.fitBounds(pts, { padding: [25, 25], maxZoom: 16 });
  else map.setView([3.139, 101.6869], 12);
  setTimeout(function () { map.invalidateSize(); }, 60);
  return map;
}

// A reusable pickup/drop-off pin picker for the request forms. The map is
// created lazily the first time a pin button is tapped.
function createPinPicker(mapElId, statusElId) {
  var st = { pickup: null, dropoff: null, mode: null, map: null, markers: {} };
  function status() {
    var parts = [];
    if (st.pickup) parts.push('📍 pickup pinned');
    if (st.dropoff) parts.push('🏁 drop-off pinned');
    if (st.mode) parts.push('tap the map to place the ' + st.mode + ' pin');
    var el = document.getElementById(statusElId);
    if (el) el.textContent = parts.join(' · ');
  }
  function ensure() {
    var el = document.getElementById(mapElId);
    if (!el) return;
    el.classList.remove('hidden');
    if (st.map || !window.L) return;
    st.map = L.map(mapElId);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
    }).addTo(st.map);
    st.map.setView([3.139, 101.6869], 12);
    st.map.on('click', function (e) {
      if (!st.mode) return;
      var k = st.mode;
      st[k] = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (st.markers[k]) st.markers[k].setLatLng(e.latlng);
      else st.markers[k] = L.marker(e.latlng, { icon: pinIcon(k) }).addTo(st.map)
        .bindPopup(k === 'pickup' ? '📍 Pickup' : '🏁 Drop-off');
      st.mode = null;
      status();
    });
    setTimeout(function () { st.map.invalidateSize(); }, 50);
  }
  return {
    arm: function (kind) { ensure(); st.mode = kind; status(); if (st.map) setTimeout(function () { st.map.invalidateSize(); }, 50); },
    reset: function () {
      st.pickup = null; st.dropoff = null; st.mode = null;
      Object.keys(st.markers).forEach(function (k) { if (st.map) st.map.removeLayer(st.markers[k]); });
      st.markers = {}; status();
    },
    get: function () { return { pickup: st.pickup, dropoff: st.dropoff }; },
  };
}

// Full-screen job map: pickup, drop-off, and the driver's vehicle if its
// position is known. A single reused overlay; navigation still hands off
// to the phone's map app.
function openFullMap(job, vehicle) {
  var host = document.getElementById('fullMapHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'fullMapHost';
    host.className = 'fullmap-host';
    document.body.appendChild(host);
  }
  var routeUrl = mapsRouteUrl(job.pickup_lat, job.pickup_lng, job.dropoff_lat, job.dropoff_lng);
  var openUrl = routeUrl
    || mapsPointUrl(job.dropoff_lat, job.dropoff_lng, job.dropoff_location)
    || mapsPointUrl(job.pickup_lat, job.pickup_lng, job.pickup_location);
  host.innerHTML =
    '<div class="fullmap-bar">' +
      '<strong>Job map</strong>' +
      '<div class="fullmap-actions">' +
        (openUrl ? '<a class="btn btn-primary btn-small" target="_blank" rel="noopener" href="' + openUrl + '">' +
          (routeUrl ? 'Open Route' : 'Open in Maps') + '</a>' : '') +
        '<button id="fullMapClose" class="btn btn-outline btn-small" type="button">Close</button>' +
      '</div>' +
    '</div>' +
    '<div id="fullMapCanvas"></div>';
  host.classList.add('open');
  var map = buildRouteMap('fullMapCanvas', job, { vehicle: vehicle, full: true });
  document.getElementById('fullMapClose').addEventListener('click', function () {
    host.classList.remove('open');
    if (map) map.remove();
    host.innerHTML = '';
  });
}

// Location freshness for display only — the stored vehicle status is
// never changed from the frontend. Live <= 5 min, old <= 30 min,
// offline beyond that.
function locationFreshness(lastUpdated) {
  if (!lastUpdated) return { label: 'No location yet', cls: 'none' };
  var mins = (Date.now() - new Date(lastUpdated).getTime()) / 60000;
  if (mins <= 5) return { label: 'Live', cls: 'live' };
  if (mins <= 30) return { label: 'Old location', cls: 'old' };
  return { label: 'Offline', cls: 'offline' };
}

// A compact "KM" line for a job: start, end and the derived total.
// Empty when no odometer was captured. Used by driver history and the
// manager/admin views — never rendered for outlet users (Stage 3B).
function kmSummaryHtml(r) {
  if (r.start_km == null && r.end_km == null) return '';
  var parts = [];
  if (r.start_km != null) parts.push('start ' + escapeHtml(r.start_km));
  if (r.end_km != null) parts.push('end ' + escapeHtml(r.end_km));
  var total = (r.start_km != null && r.end_km != null) ? (r.end_km - r.start_km) : null;
  var t = total != null ? ' · total ' + escapeHtml(total) + ' km' : '';
  return '<div class="meta">🧭 KM: ' + parts.join(' → ') + t + '</div>';
}

// ---------- Fuel logs (Stage 3C) ----------
// Shared helpers used by the manager/admin vehicle cards and the gated
// driver form. Totals are always computed here, never stored.
function fuelDayStartIso() {
  var d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString();
}

function fuelTotalsToday(logs) {
  var start = fuelDayStartIso(), l = 0, c = 0, n = 0, anyCost = false;
  (logs || []).forEach(function (f) {
    if (String(f.filled_at) >= start) {
      if (f.liters != null) l += Number(f.liters);
      if (f.cost != null) { c += Number(f.cost); anyCost = true; }
      n += 1;
    }
  });
  return { liters: l, cost: c, count: n, anyCost: anyCost };
}

function fuelTotalsLine(logs) {
  var t = fuelTotalsToday(logs);
  if (!t.count) return '<div class="meta muted">No fuel logged today.</div>';
  return '<div class="meta"><strong>Today:</strong> ' + escapeHtml(t.liters) + ' L' +
    (t.anyCost ? ' · cost ' + escapeHtml(t.cost) : '') +
    ' · ' + t.count + ' fill' + (t.count === 1 ? '' : 's') + '</div>';
}

function fuelEntryHtml(f) {
  var bits = [];
  if (f.liters != null) bits.push(escapeHtml(f.liters) + ' L');
  if (f.cost != null) bits.push('cost ' + escapeHtml(f.cost));
  var who = (f.drivers && f.drivers.name) ? ' · ' + escapeHtml(f.drivers.name) : '';
  var html = '<div class="meta">⛽ ' + (bits.join(' · ') || 'entry') +
    ' · ' + escapeHtml(fmtTime(f.filled_at)) + who;
  if (f.note) html += '<br><span class="muted">📝 ' + escapeHtml(f.note) + '</span>';
  return html + '</div>';
}

// Datetime-local input value for "now" (local time, no seconds).
function localDatetimeValue(d) {
  d = d || new Date();
  var p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function fuelFormHtml() {
  return '<div class="form-grid">' +
    '<div class="field"><label>Liters</label><input data-role="fuel-liters" type="number" min="0" step="any" inputmode="decimal" placeholder="e.g. 40"></div>' +
    '<div class="field"><label>Cost (optional)</label><input data-role="fuel-cost" type="number" min="0" step="any" inputmode="decimal" placeholder="e.g. 120"></div>' +
    '<div class="field"><label>Date / time</label><input data-role="fuel-when" type="datetime-local"></div>' +
    '<div class="field"><label>Note (optional)</label><input data-role="fuel-note" placeholder="e.g. full tank"></div>' +
  '</div>';
}

// Reads + validates the fuel form. Returns { ok, row } where row carries
// liters/cost/note/filled_at — the caller adds company/vehicle/driver ids.
function readFuelForm(scope) {
  function num(role) {
    var el = scope.querySelector('[data-role="' + role + '"]');
    if (!el || el.value.trim() === '') return { v: null };
    var n = Number(el.value);
    return (isFinite(n) && n >= 0) ? { v: n } : { bad: true };
  }
  var l = num('fuel-liters'), c = num('fuel-cost');
  if (l.bad || c.bad) return { ok: false, error: 'Please enter valid liters/cost (0 or more).' };
  if (l.v == null && c.v == null) return { ok: false, error: 'Enter at least liters or cost.' };
  var whenEl = scope.querySelector('[data-role="fuel-when"]');
  var when = (whenEl && whenEl.value) ? new Date(whenEl.value).toISOString() : new Date().toISOString();
  var noteEl = scope.querySelector('[data-role="fuel-note"]');
  return { ok: true, row: { liters: l.v, cost: c.v, note: (noteEl && noteEl.value.trim()) || null, filled_at: when } };
}

// Recent fuel entries for a vehicle (also enough rows to total "today").
async function fetchVehicleFuel(vehicleId) {
  var res = await window.sb.from('fuel_logs')
    .select('id, liters, cost, note, filled_at, driver_id, drivers(name)')
    .eq('vehicle_id', vehicleId)
    .order('filled_at', { ascending: false })
    .limit(20);
  return (res && !res.error && res.data) ? res.data : [];
}

// The inline "⛽ Fuel" panel body for a manager/admin vehicle card:
// today's totals, recent entries and an add form.
function fuelPanelHtml(logs) {
  var recent = (logs || []).slice(0, 6).map(fuelEntryHtml).join('') ||
    '<div class="meta muted">No fuel entries yet.</div>';
  return '<div class="inline-panel" data-panel data-fuel>' +
    '<h4 class="panel-sub">⛽ Fuel</h4>' +
    fuelTotalsLine(logs) +
    '<div class="fuel-list">' + recent + '</div>' +
    fuelFormHtml() +
    '<div class="request-actions">' +
      '<button class="btn btn-primary" type="button" data-action="save-fuel">Add Fuel</button>' +
      '<button class="btn btn-outline" type="button" data-action="close-fuel">Back</button>' +
    '</div></div>';
}

// One muted line with the job's lifecycle times (only the ones set).
function timesHtml(r) {
  var parts = [];
  if (r.accepted_at) parts.push('🕐 Accepted ' + fmtTime(r.accepted_at));
  if (r.started_at) parts.push('▶️ Started ' + fmtTime(r.started_at));
  if (r.completed_at) parts.push('✅ Completed ' + fmtTime(r.completed_at));
  if (r.cancelled_at) parts.push('🚫 Cancelled ' + fmtTime(r.cancelled_at));
  if (!parts.length) return '';
  return '<div class="meta">' + parts.map(escapeHtml).join(' · ') + '</div>';
}

// Shared popup for a vehicle marker: name, plate, status, updated time
// and freshness. driverName is optional (managers see it, outlets don't).
function vehiclePopupHtml(v, opts) {
  opts = opts || {};
  var fresh = locationFreshness(v.last_updated);
  var html = '<strong>' + escapeHtml(v.vehicle_name) + '</strong> · ' + escapeHtml(v.plate_number);
  if (v.status) html += '<br>Status: ' + escapeHtml(STATUS_LABELS[v.status] || v.status);
  if (opts.driverName) html += '<br>Driver: ' + escapeHtml(opts.driverName);
  html += '<br>Updated: ' + escapeHtml(fmtTime(v.last_updated)) + ' (' + escapeHtml(fresh.label) + ')';
  return html;
}

// A vehicle map whose markers update IN PLACE. Markers are keyed by
// vehicle id: new locations move the existing marker (popup stays put,
// no flicker) instead of rebuilding the layer. The view auto-fits only
// on the first locations, then the user's pan/zoom is left alone.
function createLiveVehicleMap(mapElId) {
  var map = null;
  var markers = {};
  var fitted = false;

  function vanIcon() {
    return L.divIcon({
      className: 'van-marker',
      html: '🚐',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
      popupAnchor: [0, -16],
    });
  }

  function ensureMap(center) {
    if (map || !window.L) return;
    map = L.map(mapElId);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
    }).addTo(map);
    map.setView(center || [3.139, 101.6869], 12);
  }

  function upsert(v, popupHtml) {
    if (!window.L || v.last_lat == null || v.last_lng == null) return;
    ensureMap([v.last_lat, v.last_lng]);
    var m = markers[v.id];
    if (m) {
      m.setLatLng([v.last_lat, v.last_lng]);
      m.setPopupContent(popupHtml);
    } else {
      m = L.marker([v.last_lat, v.last_lng], { icon: vanIcon() }).bindPopup(popupHtml);
      m.addTo(map);
      markers[v.id] = m;
    }
  }

  function fitOnce() {
    if (fitted || !map) return;
    var pts = Object.keys(markers).map(function (id) { return markers[id].getLatLng(); });
    if (!pts.length) return;
    if (pts.length === 1) map.setView(pts[0], 14);
    else map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
    fitted = true;
  }

  return {
    // Full sync against the current vehicle list: moves/adds markers for
    // located vehicles, removes markers whose vehicle is gone (e.g. the
    // job completed). Returns how many markers are on the map.
    sync: function (vehicles, popupFor) {
      var keep = {};
      (vehicles || []).forEach(function (v) {
        if (v.last_lat == null || v.last_lng == null) return;
        keep[v.id] = true;
        upsert(v, popupFor(v));
      });
      Object.keys(markers).forEach(function (id) {
        if (!keep[id]) {
          map.removeLayer(markers[id]);
          delete markers[id];
        }
      });
      fitOnce();
      if (map) map.invalidateSize();
      return Object.keys(markers).length;
    },
    // Single live update (realtime event): move or add one marker.
    move: function (v, popupHtml) {
      upsert(v, popupHtml);
      fitOnce();
      if (map) map.invalidateSize();
    },
    count: function () { return Object.keys(markers).length; },
  };
}

// Shows a message in the page's #flash area.
// type: 'success' | 'error' | 'warn' (amber, non-blocking heads-up).
function showFlash(message, type) {
  var host = document.getElementById('flash');
  if (!host) return;
  var cls = type === 'success' ? 'alert-success'
    : type === 'warn' ? 'alert-warn'
    : 'alert-error';
  host.innerHTML = '<div class="alert ' + cls + '">' + escapeHtml(message) + '</div>';
  clearTimeout(showFlash._timer);
  showFlash._timer = setTimeout(function () { host.innerHTML = ''; }, 5000);
  host.scrollIntoView({ block: 'nearest' });
}

// A stacked, auto-dismissing toast for live notifications. If the user
// has granted browser-notification permission, also fires a native
// notification (useful when the tab is in the background).
function showToast(message) {
  var host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  var el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  host.appendChild(el);
  setTimeout(function () {
    el.classList.add('toast-out');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
  }, 6000);

  showOsNotification(message);
}

// Fires an OS-level notification when the user has granted permission.
// On phones the Notification constructor is not allowed, so we go through
// the service worker's showNotification (which also works when the tab is
// backgrounded). Falls back to the constructor on desktop. This does NOT
// deliver anything when the app is fully closed — that needs Web Push.
function showOsNotification(message) {
  if (!window.Notification || Notification.permission !== 'granted') return;
  var opts = { body: message, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'fleetboard' };
  if (navigator.serviceWorker && navigator.serviceWorker.ready) {
    navigator.serviceWorker.ready
      .then(function (reg) { return reg.showNotification('Fleet Board Pro', opts); })
      .catch(function () {
        try { new Notification('Fleet Board Pro', opts); } catch (e) { /* ignore */ }
      });
    return;
  }
  try { new Notification('Fleet Board Pro', opts); } catch (e) { /* ignore */ }
}

// Asks for browser-notification permission. cb receives the resulting
// state: 'granted' | 'denied' | 'default' | 'unsupported'.
function requestNotifyPermission(cb) {
  cb = cb || function () {};
  if (!window.Notification) return cb('unsupported');
  if (Notification.permission === 'granted') return cb('granted');
  if (Notification.permission === 'denied') return cb('denied');
  try {
    var p = Notification.requestPermission(function (state) { cb(state); });
    if (p && typeof p.then === 'function') p.then(cb);
  } catch (e) { cb('default'); }
}
