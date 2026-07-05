// Driver dashboard: assigned jobs with Start Trip / Complete Job actions.
//
// The database does the heavy lifting: RLS only lets a driver update
// their own jobs, a trigger validates accepted → in_progress → completed
// and stamps started_at/completed_at, and the vehicle sync trigger keeps
// the vehicle busy during the job and frees it on completion. The
// frontend only sets the new status.

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
      .select('id, status, pickup_location, dropoff_location, customer_name, customer_contact, notes, created_at, accepted_at, started_at, completed_at, outlets(name), vehicles(vehicle_name, plate_number)')
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
      var extra = '';
      if (r.vehicles) {
        extra += '<span class="chip">🚐 ' + escapeHtml(r.vehicles.vehicle_name) +
                 ' · ' + escapeHtml(r.vehicles.plate_number) + '</span>';
      }
      extra += timesHtml(r);

      var actions = '';
      if (r.status === 'accepted') {
        actions = '<button class="btn btn-primary btn-block" type="button" data-action="start">Start Trip</button>';
      } else if (r.status === 'in_progress') {
        actions = '<button class="btn btn-success btn-block" type="button" data-action="complete">Complete Job</button>';
      }

      var outletName = r.outlets && r.outlets.name;
      return requestCardHtml(r, {
        topLine: outletName ? '🏬 ' + escapeHtml(outletName) : '',
        extraHtml: extra,
        actionsHtml: actions,
      });
    }).join('');
  }

  // Moves a job to the next status. The guards in .eq() make the update
  // a no-op if the job changed meanwhile (cancelled, reassigned, done) —
  // and RLS + database triggers enforce the same rules server-side.
  async function setStatus(id, fromStatus, toStatus, successMsg, errorMsg, btn) {
    btn.disabled = true;
    var res = await window.sb
      .from('vehicle_requests')
      .update({ status: toStatus })
      .eq('id', id)
      .eq('driver_id', profile.driver_id)
      .eq('status', fromStatus)
      .select('id');

    if (res.error) {
      btn.disabled = false;
      showFlash(errorMsg, 'error');
      return;
    }
    if (!res.data || !res.data.length) {
      showFlash('This job is no longer active.', 'error');
      loadJobs();
      return;
    }
    showFlash(successMsg, 'success');
    loadJobs();
  }

  jobsEl.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var id = btn.closest('.request-card').getAttribute('data-id');
    var action = btn.getAttribute('data-action');

    if (action === 'start') {
      setStatus(id, 'accepted', 'in_progress',
        'Trip started', 'Could not start trip. Please try again.', btn);
    } else if (action === 'complete') {
      setStatus(id, 'in_progress', 'completed',
        'Job completed', 'Could not complete job. Please try again.', btn);
    }
  });

  document.getElementById('refreshJobs').addEventListener('click', loadJobs);
  loadJobs();
}
