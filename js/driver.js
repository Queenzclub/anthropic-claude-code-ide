// Driver dashboard: shows jobs assigned to this driver (accepted or
// in progress). Read-only for now — start/complete comes next.
// RLS only returns requests where driver_id matches this driver.

function initDriverPage(ctx) {
  var profile = ctx.profile;
  var jobsEl = document.getElementById('jobList');

  if (!profile.driver_id) {
    jobsEl.innerHTML = '<div class="empty-state">Your account is not linked to a driver record yet. Please contact your admin.</div>';
    return;
  }

  async function loadJobs() {
    var res = await window.sb
      .from('vehicle_requests')
      .select('id, status, pickup_location, dropoff_location, customer_name, customer_contact, notes, created_at, vehicles(vehicle_name, plate_number)')
      .eq('driver_id', profile.driver_id)
      .in('status', ['accepted', 'in_progress'])
      .order('created_at', { ascending: true });

    if (res.error) {
      jobsEl.innerHTML = '<div class="empty-state">Could not load jobs. Please refresh.</div>';
      return;
    }
    if (!res.data.length) {
      jobsEl.innerHTML = '<div class="empty-state">No job assigned yet. New jobs will appear here.</div>';
      return;
    }
    jobsEl.innerHTML = res.data.map(function (r) {
      var chips = '';
      if (r.vehicles) {
        chips = '<span class="chip">🚐 ' + escapeHtml(r.vehicles.vehicle_name) +
                ' · ' + escapeHtml(r.vehicles.plate_number) + '</span>';
      }
      return requestCardHtml(r, { extraHtml: chips });
    }).join('');
  }

  document.getElementById('refreshJobs').addEventListener('click', loadJobs);
  loadJobs();
}
