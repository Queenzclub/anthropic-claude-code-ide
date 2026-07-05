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

  function loadAll() { loadPending(); loadActive(); }

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
  loadAll();
}
