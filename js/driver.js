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
  // The driver's linked vehicle row (id/name/plate/status/active/note),
  // resolved by loadReportVehicle. Drives the duty gate, the accept block,
  // and the issue-report controls. null = no usable linked vehicle.
  var linkedVehicle = null;

  // Vehicle states that mean an open issue (report is blocked) and that
  // take the vehicle out of driver self-accept.
  var VEHICLE_ISSUE_STATES = ['service_due', 'damaged', 'maintenance', 'in_service'];
  // Why the driver can't take a new job right now (null = no vehicle block;
  // off-duty is messaged separately by the empty state).
  function acceptBlockReason() {
    if (!linkedVehicle) return 'No vehicle is linked to you — you cannot accept jobs. Please contact your manager/admin.';
    if (linkedVehicle.active === false) return 'Your linked vehicle is inactive. Please contact your manager/admin.';
    if (VEHICLE_ISSUE_STATES.indexOf(linkedVehicle.status) !== -1 || linkedVehicle.status === 'offline') {
      return 'Your vehicle has an open issue (' + (STATUS_LABELS[linkedVehicle.status] || linkedVehicle.status) +
        '). You cannot accept new jobs until a manager/admin clears it.';
    }
    return null;
  }

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
    // A driver needs a linked vehicle to go on duty (also enforced by RLS
    // + a DB trigger). Going OFF duty is always allowed.
    if (!onDuty && !linkedVehicle) {
      dutyHint.textContent = 'Vehicle not linked. Please contact your manager/admin before going on duty.';
      dutyToggle.disabled = true;
      return;
    }
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
    var next = !onDuty;
    if (next && !linkedVehicle) {
      showFlash('Vehicle not linked. Please contact your manager/admin before going on duty.', 'error');
      return;
    }
    dutyToggle.disabled = true;
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

  // A prominent banner explaining why accepting is blocked (vehicle issue
  // or no vehicle). Off-duty is explained by the empty state instead.
  function renderAcceptBlock() {
    var el = document.getElementById('acceptBlock');
    if (!el) return;
    var reason = onDuty ? acceptBlockReason() : null;
    if (reason) { el.textContent = reason; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  }

  async function loadAvailable() {
    renderAcceptBlock();
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
        : 'You are off duty. Go on duty to receive and accept requests.') + '</div>';
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
    // Belt-and-suspenders: RLS already blocks these, but keep the UI honest.
    if (!onDuty) { showFlash('Go on duty to accept jobs.', 'error'); return; }
    var reason = acceptBlockReason();
    if (reason) { showFlash(reason, 'error'); loadAvailable(); return; }
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

  // Compact per-job maps built after render; removed before each re-render.
  var jobMaps = [];
  function clearJobMaps() {
    jobMaps.forEach(function (m) { try { m.remove(); } catch (e) { /* ignore */ } });
    jobMaps = [];
  }

  // Navigation block for a job card: text is already shown by the card;
  // here we add "Open Pickup/Drop-off/Route in Maps" buttons, a compact
  // map when pins exist (else a friendly note), and View Full Map.
  function navBlockHtml(r) {
    var pickupUrl = mapsPointUrl(r.pickup_lat, r.pickup_lng, r.pickup_location);
    var dropUrl = mapsPointUrl(r.dropoff_lat, r.dropoff_lng, r.dropoff_location);
    var routeUrl = mapsRouteUrl(r.pickup_lat, r.pickup_lng, r.dropoff_lat, r.dropoff_lng);
    var hasAnyPin = hasPin(r.pickup_lat, r.pickup_lng) || hasPin(r.dropoff_lat, r.dropoff_lng);

    var html = '<div class="job-nav">';
    if (hasAnyPin) {
      html += '<div class="job-map" id="jobmap-' + escapeHtml(r.id) + '"></div>';
    } else {
      html += '<p class="muted small">No map pin added for this request.</p>';
    }
    html += '<div class="nav-btns">';
    if (pickupUrl) html += '<a class="btn btn-outline btn-small" target="_blank" rel="noopener" href="' + pickupUrl + '">📍 Open Pickup in Maps</a>';
    if (dropUrl) html += '<a class="btn btn-outline btn-small" target="_blank" rel="noopener" href="' + dropUrl + '">🏁 Open Drop-off in Maps</a>';
    if (routeUrl) html += '<a class="btn btn-outline btn-small" target="_blank" rel="noopener" href="' + routeUrl + '">🧭 Open Route in Maps</a>';
    if (hasAnyPin) html += '<button class="btn btn-outline btn-small" type="button" data-action="fullmap">🗺️ View Full Map</button>';
    html += '</div></div>';
    return html;
  }

  async function loadJobs() {
    var res = await window.sb
      .from('vehicle_requests')
      .select('id, status, vehicle_id, start_km, end_km, pickup_location, dropoff_location, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, customer_name, customer_contact, notes, created_at, accepted_at, started_at, completed_at, outlets(name), vehicles!vehicle_id(vehicle_name, plate_number, last_lat, last_lng, last_updated, current_km)')
      .eq('driver_id', profile.driver_id)
      .in('status', ['accepted', 'in_progress'])
      .order('created_at', { ascending: true });

    clearJobMaps();
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
      extra += navBlockHtml(r);

      var actions = '';
      if (r.status === 'accepted') {
        actions = kmBlockHtml(r) +
          '<button class="btn btn-primary btn-block" type="button" data-action="start">Start Trip</button>';
      } else if (r.status === 'in_progress') {
        actions = kmBlockHtml(r) +
          '<button class="btn btn-success btn-block" type="button" data-action="complete">Complete Job</button>';
      }

      var outletName = r.outlets && r.outlets.name;
      var origin = outletName ? '🏬 ' + escapeHtml(outletName) : '🧑‍💼 Manager request';
      return requestCardHtml(r, {
        topLine: '<strong>#' + (i + 1) + '</strong> · ' + origin,
        extraHtml: extra,
        actionsHtml: actions,
      });
    }).join('');

    // Build the compact maps for jobs that have at least one pin.
    res.data.forEach(function (r) {
      if (hasPin(r.pickup_lat, r.pickup_lng) || hasPin(r.dropoff_lat, r.dropoff_lng)) {
        var m = buildRouteMap('jobmap-' + r.id, r, { vehicle: r.vehicles });
        if (m) jobMaps.push(m);
      }
    });
  }

  // Odometer entry on the job card: a Start KM input while accepted, an
  // End KM input while in progress. Both optional — the trip still
  // starts/completes with no KM. The server (Migration 19) is the source
  // of truth for the rules; this just keeps entry easy and fast.
  function kmBlockHtml(r) {
    if (r.status === 'accepted') {
      var cur = (r.vehicles && r.vehicles.current_km != null)
        ? ' · current ' + escapeHtml(r.vehicles.current_km) : '';
      return '<div class="km-field"><label>Start KM (optional' + cur + ')</label>' +
        '<input class="input-block" type="number" min="0" inputmode="numeric" id="startkm-' + escapeHtml(r.id) + '"' +
        (r.start_km != null ? ' value="' + escapeHtml(r.start_km) + '"' : '') +
        ' placeholder="Odometer at start"></div>';
    }
    if (r.status === 'in_progress') {
      var startLine = r.start_km != null ? '<div class="meta">🧭 Start KM: ' + escapeHtml(r.start_km) + '</div>' : '';
      return startLine + '<div class="km-field"><label>End KM (optional)</label>' +
        '<input class="input-block" type="number" min="0" inputmode="numeric" id="endkm-' + escapeHtml(r.id) + '"' +
        (r.end_km != null ? ' value="' + escapeHtml(r.end_km) + '"' : '') +
        ' placeholder="Odometer at finish"></div>';
    }
    return '';
  }

  // Reads a KM input: null when blank, or a validated non-negative number.
  function readKm(inputId) {
    var el = document.getElementById(inputId);
    if (!el || el.value.trim() === '') return { ok: true, value: null };
    var n = Number(el.value);
    if (!isFinite(n) || n < 0) return { ok: false, error: 'Please enter a valid KM (0 or more).' };
    return { ok: true, value: n };
  }

  // Moves a job to the next status, optionally writing KM columns in the
  // same update. The guards in .eq() make it a no-op if the job changed
  // meanwhile, and RLS + database triggers enforce the rules server-side.
  async function setStatus(id, fromStatus, toStatus, successMsg, errorMsg, btn, extraCols) {
    btn.disabled = true;
    var res = await window.sb
      .from('vehicle_requests')
      .update(Object.assign({ status: toStatus }, extraCols || {}))
      .eq('id', id)
      .eq('driver_id', profile.driver_id)
      .eq('status', fromStatus)
      .select('id');

    if (res.error) {
      btn.disabled = false;
      var m = (res.error.message || '');
      // Surface the specific KM validation message; otherwise stay generic.
      showFlash(/km/i.test(m) ? m : errorMsg, 'error');
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
      var sk = readKm('startkm-' + id);
      if (!sk.ok) { showFlash(sk.error, 'error'); return; }
      setStatus(id, 'accepted', 'in_progress',
        'Trip started', 'Could not start trip. Please try again.', btn,
        sk.value != null ? { start_km: sk.value } : null);
    } else if (action === 'complete') {
      var ek = readKm('endkm-' + id);
      if (!ek.ok) { showFlash(ek.error, 'error'); return; }
      var job = activeJobs.filter(function (j) { return j.id === id; })[0];
      if (ek.value != null && job && job.start_km != null && ek.value < job.start_km) {
        showFlash('End KM cannot be less than Start KM (' + job.start_km + ').', 'error');
        return;
      }
      setStatus(id, 'in_progress', 'completed',
        'Job completed', 'Could not complete job. Please try again.', btn,
        ek.value != null ? { end_km: ek.value } : null);
    } else if (action === 'fullmap') {
      var job = activeJobs.filter(function (j) { return j.id === id; })[0];
      if (job) openFullMap(job, job.vehicles);
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

  // ---------- Report vehicle issue ----------
  // A driver can flag ONLY their own linked vehicle as Service Due or
  // Damaged (optionally with a short note). RLS plus a database guard
  // trigger enforce this: no other vehicle, no other status, and a driver
  // can never clear a reported issue — only a manager/admin can.
  var reportVehicleEl = document.getElementById('reportVehicle');
  var reportControls = document.getElementById('reportControls');
  var reportNote = document.getElementById('reportNote');
  var reportServiceDueBtn = document.getElementById('reportServiceDue');
  var reportDamagedBtn = document.getElementById('reportDamaged');
  var reportIssueMsg = document.getElementById('reportIssueMsg');

  function renderReport() {
    if (!linkedVehicle) {
      reportVehicleEl.textContent = 'No vehicle is linked to you yet. Ask your manager to link one.';
      reportControls.classList.add('hidden');
      return;
    }
    var v = linkedVehicle;
    reportVehicleEl.innerHTML = '🚐 ' + escapeHtml(v.vehicle_name) + ' · ' + escapeHtml(v.plate_number) +
      ' — ' + statusBadge(v.status);
    if (v.service_note) {
      reportVehicleEl.innerHTML += '<br><span class="muted">📝 ' + escapeHtml(v.service_note) + '</span>';
    }
    reportControls.classList.remove('hidden');
    // Already flagged: one open issue at a time — disable until cleared.
    var flagged = VEHICLE_ISSUE_STATES.indexOf(v.status) !== -1;
    reportServiceDueBtn.disabled = flagged;
    reportDamagedBtn.disabled = flagged;
    reportIssueMsg.classList.toggle('hidden', !flagged);
  }

  async function loadReportVehicle() {
    await loadOwnVehicle();
    var q = window.sb.from('vehicles').select('id, vehicle_name, plate_number, status, service_note, active');
    q = ownVehicleId ? q.eq('id', ownVehicleId) : q.eq('driver_id', profile.driver_id);
    var res = await q.limit(1);
    linkedVehicle = (!res.error && res.data && res.data.length) ? res.data[0] : null;
    if (linkedVehicle && !ownVehicleId) ownVehicleId = linkedVehicle.id;
    renderReport();
    // The linked vehicle drives the duty gate and the accept block too.
    renderDuty();
    loadAvailable();
  }

  async function reportIssue(newStatus, btn) {
    if (!linkedVehicle) return;
    btn.disabled = true;
    var note = (reportNote.value || '').trim();
    var upd = { status: newStatus };
    if (note) upd.service_note = note;
    var res = await window.sb.from('vehicles')
      .update(upd)
      .eq('id', linkedVehicle.id)
      .select('id, status, service_note');
    btn.disabled = false;
    if (res.error || !res.data || !res.data.length) {
      showFlash('Could not report the issue. Please try again.', 'error');
      return;
    }
    linkedVehicle.status = res.data[0].status;
    linkedVehicle.service_note = res.data[0].service_note;
    reportNote.value = '';
    renderReport();
    // Reporting takes the vehicle out of dispatch — refresh the inbox/gate.
    renderDuty();
    loadAvailable();
    showFlash('Issue reported. Manager/admin should review.', 'success');
  }

  document.getElementById('reportServiceDue').addEventListener('click', function (e) { reportIssue('service_due', e.currentTarget); });
  document.getElementById('reportDamaged').addEventListener('click', function (e) { reportIssue('damaged', e.currentTarget); });

  // ---------- Recent jobs (history) ----------
  // The driver's own completed/cancelled jobs. The vehicle name only
  // appears when RLS still allows reading that vehicle (their default
  // vehicle) — visibility of other vehicles correctly ends with the job.
  var recentEl = document.getElementById('recentList');

  async function loadRecent() {
    var res = await window.sb
      .from('vehicle_requests')
      .select('id, status, start_km, end_km, pickup_location, dropoff_location, customer_name, customer_contact, notes, created_at, completed_at, cancelled_at, vehicles!vehicle_id(vehicle_name, plate_number)')
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
      extra += kmSummaryHtml(r);
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
  loadReportVehicle();

  // Live notifications: toast + badge when a new request this driver can
  // take is created. Refreshes the inbox so Accept is immediately usable.
  if (typeof initDriverNotifications === 'function') {
    initDriverNotifications(profile, loadAvailable);
    initAlertsButton('enableAlerts');
  }
}
