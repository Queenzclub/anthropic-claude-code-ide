// Shared UI helpers for dashboard pages: escaping, formatting,
// status badges, request cards, and flash messages.

var STATUS_LABELS = {
  pending: 'Pending',
  accepted: 'Accepted',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
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

// Shows a message in the page's #flash area. type: 'success' | 'error'.
function showFlash(message, type) {
  var host = document.getElementById('flash');
  if (!host) return;
  host.innerHTML = '<div class="alert ' +
    (type === 'success' ? 'alert-success' : 'alert-error') + '">' +
    escapeHtml(message) + '</div>';
  clearTimeout(showFlash._timer);
  showFlash._timer = setTimeout(function () { host.innerHTML = ''; }, 5000);
  host.scrollIntoView({ block: 'nearest' });
}
