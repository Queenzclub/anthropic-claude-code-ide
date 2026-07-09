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
  var availableEl = document.getElementById('availableList');
  var activeJobs = [];
  var onDuty = false;
  var ownVehicleId = profile.vehicle_id || null;

  if (!profile.driver_id) {
    jobsEl.innerHTML = '<div class="empty-state">Your account is not linked to a driver record yet. Please contact your admin.</div>';
    if (availableEl) availableEl.innerHTML = '';
    return;
  }

  // ---------- Duty status ----------
  // The driver flips their own on_duty flag (RLS + a DB trigger allow
  // exactly that and nothing else). Open requests are only visible
  // while on duty — the database enforces it; the UI just explains it.
  var dutyBadge = document.getElementById('dutyBadge');
  var dutyToggle = document.getElementById('dutyToggle');
  var dutyHint = document.getElementById('dutyHint');

  function renderDuty() {
    dutyBadge.textContent = onDuty ? 'On Duty' : 'Off Duty';
    dutyBadge.className = 'badge ' + (onDuty ? 'badge-available' : 'badge-offline');
    dutyToggle.textContent = onDuty ? 'Go Off Duty' : 'Go On Duty';
    dutyToggle.classList.toggle('btn-primary', !onDuty);
    dutyToggle.classList.toggle('btn-outline', onDuty);
    dutyHint.textContent = onDuty
      ? 'You receive open requests and share your location while on duty.'
      : 'Go on duty to receive open delivery requests.';
    dutyToggle.disabled = false;
  }

  async function loadDuty() {
    var res = await window.sb.from('drivers')
      .select('on_duty').eq('id', profile.driver_id).maybeSingle();
    onDuty = !!(res && res.data && res.data.on_duty);
    renderDuty();
  }

  async function toggleDuty() {
    dutyToggle.disabled = true;
    var next = !onDuty;
    var res = await window.sb.from('drivers')
      .update({ on_duty: next, on_duty_since: new Date().toISOString() })
      .eq('id', profile.driver_id)
      .select('on_duty');
    if (res.error || !res.data || !res.data.length) {
      dutyToggle.disabled = false;
      showFlash('Could not change duty status. Please try again.', 'error');
      return;
    }
    onDuty = res.data[0].on_duty;
    renderDuty();
    loadAvailable();
    if (onDuty) {
      showFlash('You are on duty', 'success');
      if (!sharing.on) startSharing();
    } else {
      if (sharing.on) stopSharing('Location sharing stopped');
      showFlash('You are off duty', 'success');
    }
  }
  dutyToggle.addEventListener('click', toggleDuty);

  // The driver's own van (used for location pings between jobs while on
  // duty). profile.vehicle_id wins if the admin set a default vehicle.
  async function loadOwnVehicle() {
    if (ownVehicleId) return;
    var res = await window.sb.from('vehicles')
      .select('id').eq('driver_id', profile.driver_id).eq('active', true).limit(1);
    if (!res.error && res.data && res.data.length) ownVehicleId = res.data[0].id;
  }

  // ---------- Available requests (dispatch inbox) ----------
  // RLS returns only pending requests dispatched to this driver: open
  // company requests, or ones specifically targeted at them.
  var availBadge = document.getElementById('availBadge');
  function setAvailBadge(n) {
    if (!availBadge) return;
    if (n > 0) { availBadge.textContent = n; availBadge.classList.remove('hidden'); }
    else availBadge.classList.add('hidden');
  }

  async function loadAvailable() {
    var res = await window.sb
      .from('vehicle_requests')
      .select('id, status, dispatch_mode, pickup_location, dropoff_location, customer_name, customer_contact, notes, created_at, outlets(name)')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (res.error) {
      availableEl.innerHTML = '<div class="empty-state">Could not load requests. Please refresh.</div>';
      setAvailBadge(0);
      return;
    }
    setAvailBadge(res.data.length);
    if (!res.data.length) {
      availableEl.innerHTML = '<div class="empty-state">' + (onDuty
        ? 'No available requests right now.'
        : 'You are off duty. Only requests assigned directly to you appear here.') + '</div>';
      return;
    }
    availableEl.innerHTML = res.data.map(function (r) {
      var mode = r.dispatch_mode === 'specific'
        ? '<span class="chip">🎯 For you</span>'
        : '<span class="chip">📢 Open request</span>';
      var outletName = r.outlets && r.outlets.name;
      var origin = outletName ? '🏬 ' + escapeHtml(outletName) : '🧑‍💼 Manager request';
      var stackHint = activeJobs.length
        ? '<p class="muted small">Adds to your current jobs (' + activeJobs.length + ' active)</p>'
        : '';
      return requestCardHtml(r, {
        topLine: origin + ' ' + mode,
        actionsHtml: '<button class="btn btn-primary btn-block" type="button" data-action="accept">Accept Job</button>' + stackHint,
      });
    }).join('');
  }

  async function acceptJob(id, btn) {
    btn.disabled = true;
    // Only claim the job for this driver. The database assigns the
    // driver's vehicle automatically (so the outlet can track it) — the
    // client no longer needs to know or send the vehicle id.
    var res = await window.sb
      .from('vehicle_requests')
      .update({ status: 'accepted', driver_id: profile.driver_id })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id');

    if (res.error) {
      btn.disabled = false;
      showFlash('Could not accept the job. Please try again.', 'error');
      return;
    }
    if (!res.data || !res.data.length) {
      showFlash('This request was already taken.', 'error');
    } else if (activeJobs.length >= 3) {
      // Soft warning only — stacking is allowed, just make it visible.
      showFlash('Job accepted. You already had ' + activeJobs.length +
        ' active jobs — this one was added to your queue.', 'warn');
    } else {
      showFlash('Job accepted', 'success');
    }
    loadAvailable();
    loadJobs();
  }

  availableEl.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action="accept"]');
    if (!btn) return;
    acceptJob(btn.closest('.request-card').getAttribute('data-id'), btn);
  });

  async function loadJobs() {
    var res = await window.sb
      .from('vehicle_requests')
      .select('id, status, vehicle_id, pickup_location, dropoff_location, customer_name, customer_contact, notes, created_at, accepted_at, started_at, completed_at, outlets(name), vehicles!vehicle_id(vehicle_name, plate_number)')
      .eq('driver_id', profile.driver_id)
      .in('status', ['accepted', 'in_progress'])
      .order('created_at', { ascending: true });

    if (res.error) {
      jobsEl.innerHTML = '<div class="empty-state">Could not load jobs. Please refresh.</div>';
      return;
    }
    activeJobs = res.data;

    // Sharing turns itself off only when there is neither an active job
    // nor an on-duty shift — on-duty drivers keep sharing between jobs.
    if (sharing.on && !activeJobs.length && !onDuty) {
      stopSharing('Location sharing stopped');
    }

    var jobsBadge = document.getElementById('jobsBadge');
    if (jobsBadge) {
      if (res.data.length) { jobsBadge.textContent = res.data.length; jobsBadge.classList.remove('hidden'); }
      else jobsBadge.classList.add('hidden');
    }
    if (!res.data.length) {
      jobsEl.innerHTML = '<div class="empty-state">No job assigned yet. New jobs will appear here.</div>';
      return;
    }
    // The queue is numbered by accept order (query is ordered by
    // created_at ascending); each job keeps its own Start/Complete.
    jobsEl.innerHTML = res.data.map(function (r, i) {
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
      var origin = outletName ? '🏬 ' + escapeHtml(outletName) : '🧑‍💼 Manager request';
      return requestCardHtml(r, {
        topLine: '<strong>#' + (i + 1) + '</strong> · ' + origin,
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
      loadRecent();
      return;
    }
    showFlash(successMsg, 'success');
    loadJobs();
    loadRecent();
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

  // ---------- Location sharing ----------
  // The driver's position is inserted into location_updates every
  // 45 seconds while sharing is on. RLS only accepts the driver's own
  // driver_id and company, and a DB trigger mirrors the latest point
  // onto the vehicle for the manager's map. Sharing requires an active
  // job so the location is tied to the right vehicle, and stops
  // automatically when the job ends.

  // 30s balances live-feeling maps against phone battery. Phones pause
  // JS timers/GPS when the app is closed or the screen locks (especially
  // iPhone), so updates flow while the app stays open in the foreground.
  var LOCATION_INTERVAL_MS = 30000;
  var sharing = { on: false, timer: null };
  var locStatus = document.getElementById('locStatus');
  var locLast = document.getElementById('locLast');
  var locToggle = document.getElementById('locToggle');

  function renderSharingState() {
    if (sharing.on) {
      locStatus.textContent = 'Location sharing is on.';
      locToggle.textContent = 'Stop Sharing';
      locToggle.classList.remove('btn-primary');
      locToggle.classList.add('btn-danger');
    } else {
      locStatus.textContent = 'Location sharing is off.';
      locToggle.textContent = 'Share Location';
      locToggle.classList.remove('btn-danger');
      locToggle.classList.add('btn-primary');
    }
    locToggle.disabled = false;
  }

  async function sendLocation(pos) {
    var res = await window.sb.from('location_updates').insert({
      company_id: profile.company_id,
      driver_id: profile.driver_id,
      // On a job: that job's vehicle. Between jobs while on duty: the
      // driver's own van, so the manager map shows idle on-duty vans.
      vehicle_id: activeJobs.length ? activeJobs[0].vehicle_id : ownVehicleId,
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
    });
    if (res.error) {
      showFlash('Could not update location. Please try again.', 'error');
      return;
    }
    locLast.textContent = 'Last update: ' +
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function onGeoError(err) {
    stopSharing(null);
    if (err && err.code === 1) {
      showFlash('Location permission is required to share your location', 'error');
    } else {
      showFlash('Could not update location. Please try again.', 'error');
    }
  }

  function tick() {
    navigator.geolocation.getCurrentPosition(sendLocation, onGeoError, {
      enableHighAccuracy: true, maximumAge: 15000, timeout: 20000,
    });
  }

  function startSharing() {
    if (!activeJobs.length && !onDuty) {
      showFlash('Go on duty or accept a job to share your location', 'error');
      return;
    }
    if (!navigator.geolocation) {
      showFlash('Location is not available on this device.', 'error');
      return;
    }
    locToggle.disabled = true;
    locStatus.textContent = 'Requesting location…';
    // Only switch ON after the first successful position fix.
    navigator.geolocation.getCurrentPosition(function (pos) {
      sharing.on = true;
      sharing.timer = setInterval(tick, LOCATION_INTERVAL_MS);
      renderSharingState();
      showFlash('Location sharing started', 'success');
      sendLocation(pos);
    }, function (err) {
      renderSharingState();
      onGeoError(err);
    }, { enableHighAccuracy: true, timeout: 20000 });
  }

  function stopSharing(msg) {
    sharing.on = false;
    if (sharing.timer) {
      clearInterval(sharing.timer);
      sharing.timer = null;
    }
    renderSharingState();
    if (msg) showFlash(msg, 'success');
  }

  locToggle.addEventListener('click', function () {
    if (sharing.on) stopSharing('Location sharing stopped');
    else startSharing();
  });

  // ---------- Recent jobs (history) ----------
  // The driver's own completed/cancelled jobs. The vehicle name only
  // appears when RLS still allows reading that vehicle (their default
  // vehicle) — visibility of other vehicles correctly ends with the job.
  var recentEl = document.getElementById('recentList');

  async function loadRecent() {
    var res = await window.sb
      .from('vehicle_requests')
      .select('id, status, pickup_location, dropoff_location, customer_name, customer_contact, notes, created_at, completed_at, cancelled_at, vehicles!vehicle_id(vehicle_name, plate_number)')
      .eq('driver_id', profile.driver_id)
      .in('status', ['completed', 'cancelled'])
      .order('updated_at', { ascending: false })
      .limit(10);

    if (res.error) {
      recentEl.innerHTML = '<div class="empty-state">Could not load recent jobs. Please refresh.</div>';
      return;
    }
    if (!res.data.length) {
      recentEl.innerHTML = '<div class="empty-state">No recent history.</div>';
      return;
    }
    recentEl.innerHTML = res.data.map(function (r) {
      var extra = '';
      if (r.vehicles) {
        extra += '<span class="chip">🚐 ' + escapeHtml(r.vehicles.vehicle_name) +
                 ' · ' + escapeHtml(r.vehicles.plate_number) + '</span>';
      }
      var closed = r.completed_at
        ? '✅ Completed ' + fmtTime(r.completed_at)
        : (r.cancelled_at ? '🚫 Cancelled ' + fmtTime(r.cancelled_at) : '');
      if (closed) extra += '<div class="meta">' + escapeHtml(closed) + '</div>';
      return requestCardHtml(r, { extraHtml: extra });
    }).join('');
  }

  renderSharingState();
  document.getElementById('refreshJobs').addEventListener('click', function () {
    loadAvailable();
    loadJobs();
    loadRecent();
  });
  loadDuty().then(loadAvailable);
  loadOwnVehicle();
  loadJobs();
  loadRecent();

  // Live notifications: toast + badge when a new request this driver can
  // take is created. Refreshes the inbox so Accept is immediately usable.
  if (typeof initDriverNotifications === 'function') {
    initDriverNotifications(profile, loadAvailable);
    initAlertsButton('enableAlerts');
  }
}
