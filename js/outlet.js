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
    if (!res.data.length) {
      listEl.innerHTML = '<div class="empty-state">No active requests. Create one above.</div>';
      return;
    }
    listEl.innerHTML = res.data.map(function (r) {
      // Outlet users see THAT a driver/vehicle is assigned, not who —
      // driver details and locations stay private from outlets.
      var chips = '';
      if (r.driver_id) chips += '<span class="chip">👤 Driver assigned</span>';
      if (r.vehicle_id) chips += '<span class="chip">🚐 Vehicle assigned</span>';
      return requestCardHtml(r, { extraHtml: chips });
    }).join('');
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
    var res = await window.sb.from('vehicle_requests').insert({
      company_id: profile.company_id,
      outlet_id: profile.outlet_id,
      requested_by: profile.user_id,
      status: 'pending',
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
    showFlash('Vehicle request created successfully.', 'success');
    loadRequests();
  });

  document.getElementById('refreshRequests').addEventListener('click', loadRequests);
  loadRequests();
}
