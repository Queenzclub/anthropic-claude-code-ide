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
};

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
