// Admin dashboard: company setup and daily management.
//
// Every write goes through the existing admin RLS policies — the
// database only accepts changes to this company's rows, and triggers
// guard role escalation (profiles) and vehicle status safety
// (a vehicle with an active job can't be set back to available).
// Creating login accounts still happens in the Supabase Dashboard;
// this page never touches auth or any private key.

function initAdminPage(ctx) {
  var profile = ctx.profile;
  var myUid = profile.user_id;
  var cache = { outlets: [], drivers: [], vehicles: [], profiles: [] };
  var jobFilter = 'all';

  var overviewEl = document.getElementById('overviewStats');
  var userListEl = document.getElementById('userList');
  var outletListEl = document.getElementById('outletList');
  var driverListEl = document.getElementById('driverList');
  var vehicleListEl = document.getElementById('vehicleList');
  var jobListEl = document.getElementById('jobList');

  // ---------- Small helpers ----------

  function todayIso() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  function count(list, fn) { return list.filter(fn).length; }

  function activeBadge(on) {
    return on ? '<span class="badge badge-available">Active</span>'
              : '<span class="badge badge-offline">Inactive</span>';
  }

  function selectOptions(list, selectedId, placeholder, labelFn) {
    var html = '<option value="">' + escapeHtml(placeholder) + '</option>';
    list.forEach(function (item) {
      html += '<option value="' + escapeHtml(item.id) + '"' +
        (item.id === selectedId ? ' selected' : '') + '>' +
        escapeHtml(labelFn(item)) + '</option>';
    });
    return html;
  }

  function fieldHtml(label, inner, extraAttrs) {
    return '<div class="field"' + (extraAttrs || '') + '><label>' + label + '</label>' + inner + '</div>';
  }

  function inputHtml(role, value, placeholder) {
    return '<input data-role="' + role + '" value="' + escapeHtml(value || '') +
      '" placeholder="' + escapeHtml(placeholder || '') + '">';
  }

  function panelActions(saveAction, saveLabel) {
    return '<div class="request-actions">' +
      '<button class="btn btn-primary" type="button" data-action="' + saveAction + '">' + saveLabel + '</button>' +
      '<button class="btn btn-outline" type="button" data-action="close-panel">Back</button></div>';
  }

  function closePanels(root) {
    root.querySelectorAll('[data-panel]').forEach(function (p) { p.remove(); });
  }

  function readPanel(scope, role) {
    var el = scope.querySelector('[data-role="' + role + '"]');
    return el ? el.value.trim() : '';
  }

  async function guardedUpdate(table, upd, idCol, id) {
    return window.sb.from(table).update(upd).eq(idCol, id).select(idCol);
  }

  // ---------- Data fetch (parallel, then render) ----------

  async function fetchEntities() {
    var results = await Promise.all([
      window.sb.from('outlets').select('id, name, address, phone, active').order('name', { ascending: true }),
      window.sb.from('drivers').select('id, name, phone, license_number, active').order('name', { ascending: true }),
      window.sb.from('vehicles').select('id, vehicle_name, plate_number, status, driver_id, active').order('vehicle_name', { ascending: true }),
      window.sb.from('profiles').select('user_id, name, email, phone, role, active, outlet_id, driver_id, outlets(name), drivers(name)').order('email', { ascending: true }),
    ]);
    if (results.some(function (r) { return r.error; })) {
      showFlash('Could not load company data. Please refresh.', 'error');
      return false;
    }
    cache.outlets = results[0].data;
    cache.drivers = results[1].data;
    cache.vehicles = results[2].data;
    cache.profiles = results[3].data;
    return true;
  }

  async function refreshAll() {
    if (!(await fetchEntities())) return;
    renderUsers();
    renderOutlets();
    renderDrivers();
    renderVehicles();
    loadOverview();
    loadJobs();
  }

  // ---------- Today overview ----------

  async function loadOverview() {
    var results = await Promise.all([
      window.sb.from('vehicle_requests').select('id, status').in('status', ['pending', 'accepted', 'in_progress']),
      window.sb.from('vehicle_requests').select('id, status').in('status', ['completed', 'cancelled']).gte('updated_at', todayIso()),
    ]);
    if (results.some(function (r) { return r.error; })) {
      overviewEl.innerHTML = '<div class="empty-state">Could not load overview.</div>';
      return;
    }
    var open = results[0].data;
    var closed = results[1].data;
    var tiles = [
      [count(cache.profiles, function (p) { return p.active; }), 'Active Users'],
      [count(cache.outlets, function (o) { return o.active; }), 'Active Outlets'],
      [count(cache.drivers, function (d) { return d.active; }), 'Active Drivers'],
      [count(cache.vehicles, function (v) { return v.active && v.status === 'available'; }), 'Available Vehicles'],
      [count(cache.vehicles, function (v) { return v.status === 'busy'; }), 'Busy Vehicles'],
      [count(open, function (r) { return r.status === 'pending'; }), 'Pending Requests'],
      [count(open, function (r) { return r.status !== 'pending'; }), 'Active Jobs'],
      [count(closed, function (r) { return r.status === 'completed'; }), 'Completed Today'],
      [count(closed, function (r) { return r.status === 'cancelled'; }), 'Cancelled Today'],
    ];
    overviewEl.innerHTML = tiles.map(function (t) {
      return '<div class="stat"><div class="stat-num">' + t[0] + '</div>' +
        '<div class="stat-label">' + t[1] + '</div></div>';
    }).join('');
  }

  // ---------- Users / profiles ----------

  function renderUsers() {
    if (!cache.profiles.length) {
      userListEl.innerHTML = '<div class="empty-state">No users in your company yet.</div>';
      return;
    }
    userListEl.innerHTML = cache.profiles.map(function (u) {
      var chips = '';
      if (u.outlets && u.outlets.name) chips += '<span class="chip">🏬 ' + escapeHtml(u.outlets.name) + '</span>';
      if (u.drivers && u.drivers.name) chips += '<span class="chip">🚗 ' + escapeHtml(u.drivers.name) + '</span>';
      return '<div class="card" data-id="' + escapeHtml(u.user_id) + '">' +
        '<div class="request-top"><strong>' + escapeHtml(u.name || u.email) +
          (u.user_id === myUid ? ' <span class="muted small">(you)</span>' : '') + '</strong>' +
        '<span><span class="badge badge-role-' + escapeHtml(u.role) + '">' + escapeHtml(ROLE_LABELS[u.role] || u.role) + '</span> ' +
          activeBadge(u.active) + '</span></div>' +
        '<div class="meta">✉️ ' + escapeHtml(u.email || '') + '</div>' + chips +
        '<div class="request-actions">' +
          '<button class="btn btn-outline" type="button" data-action="edit-user">Edit Role</button>' +
          '<button class="btn ' + (u.active ? 'btn-outline' : 'btn-primary') + '" type="button" data-action="toggle-user">' +
            (u.active ? 'Deactivate' : 'Activate') + '</button>' +
        '</div></div>';
    }).join('');
  }

  function openUserPanel(card, u) {
    closePanels(userListEl);
    var roles = ['admin', 'manager', 'outlet', 'driver'];
    var roleOptions = roles.map(function (r) {
      return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + ROLE_LABELS[r] + '</option>';
    }).join('');
    var activeOutlets = cache.outlets.filter(function (o) { return o.active; });
    var activeDrivers = cache.drivers.filter(function (d) { return d.active; });
    card.insertAdjacentHTML('beforeend',
      '<div class="inline-panel" data-panel><div class="form-grid">' +
        fieldHtml('Role', '<select data-role="user-role">' + roleOptions + '</select>') +
        fieldHtml('Outlet', '<select data-role="user-outlet">' +
          selectOptions(activeOutlets, u.outlet_id, 'Choose outlet…', function (o) { return o.name; }) +
          '</select>', u.role === 'outlet' ? '' : ' hidden') +
        fieldHtml('Driver record', '<select data-role="user-driver">' +
          selectOptions(activeDrivers, u.driver_id, 'Choose driver…', function (d) { return d.name; }) +
          '</select>', u.role === 'driver' ? '' : ' hidden') +
      '</div>' + panelActions('save-user', 'Save') + '</div>');
  }

  async function saveUser(card, id, btn) {
    var role = readPanel(card, 'user-role');
    var upd = { role: role, outlet_id: null, driver_id: null };
    if (role === 'outlet') {
      upd.outlet_id = readPanel(card, 'user-outlet');
      if (!upd.outlet_id) { showFlash('Please choose an outlet for this user.', 'error'); return; }
    }
    if (role === 'driver') {
      upd.driver_id = readPanel(card, 'user-driver');
      if (!upd.driver_id) { showFlash('Please choose a driver record for this user.', 'error'); return; }
    }
    if (id === myUid && role !== 'admin' &&
        !window.confirm('Change your own role? You will lose access to this admin dashboard.')) {
      return;
    }
    btn.disabled = true;
    var res = await guardedUpdate('profiles', upd, 'user_id', id);
    if (res.error || !res.data || !res.data.length) {
      btn.disabled = false;
      showFlash('Could not update this user. Please try again.', 'error');
      return;
    }
    showFlash('User updated.', 'success');
    refreshAll();
  }

  async function toggleUser(id, btn) {
    var u = cache.profiles.find(function (p) { return p.user_id === id; });
    if (!u) return;
    if (u.active && id === myUid &&
        !window.confirm('Deactivate your own admin account? You will immediately lose access to Fleet Board Pro.')) {
      return;
    }
    btn.disabled = true;
    var res = await guardedUpdate('profiles', { active: !u.active }, 'user_id', id);
    if (res.error || !res.data || !res.data.length) {
      btn.disabled = false;
      showFlash('Could not update this user. Please try again.', 'error');
      return;
    }
    showFlash(u.active ? 'User deactivated.' : 'User activated.', 'success');
    refreshAll();
  }

  // ---------- Outlets ----------

  function outletFormHtml(o, saveAction, saveLabel) {
    return '<div class="inline-panel" data-panel><div class="form-grid">' +
      fieldHtml('Outlet name *', inputHtml('outlet-name', o && o.name, 'e.g. Main Shop')) +
      fieldHtml('Address', inputHtml('outlet-address', o && o.address, 'Street address')) +
      fieldHtml('Contact number', inputHtml('outlet-phone', o && o.phone, 'Phone number')) +
      '</div>' + panelActions(saveAction, saveLabel) + '</div>';
  }

  function renderOutlets() {
    outletListEl.innerHTML = cache.outlets.length ? cache.outlets.map(function (o) {
      return '<div class="card" data-id="' + escapeHtml(o.id) + '">' +
        '<div class="request-top"><strong>' + escapeHtml(o.name) + '</strong>' + activeBadge(o.active) + '</div>' +
        (o.address ? '<div class="meta">📍 ' + escapeHtml(o.address) + '</div>' : '') +
        (o.phone ? '<div class="meta">📞 ' + escapeHtml(o.phone) + '</div>' : '') +
        '<div class="request-actions">' +
          '<button class="btn btn-outline" type="button" data-action="edit-outlet">Edit</button>' +
          '<button class="btn btn-outline" type="button" data-action="toggle-outlet">' + (o.active ? 'Deactivate' : 'Activate') + '</button>' +
        '</div></div>';
    }).join('') : '<div class="empty-state">No outlets yet. Add your first outlet above.</div>';
  }

  async function saveOutlet(scope, id, btn) {
    var name = readPanel(scope, 'outlet-name');
    if (!name) { showFlash('Please enter the outlet name.', 'error'); return; }
    var data = { name: name, address: readPanel(scope, 'outlet-address') || null, phone: readPanel(scope, 'outlet-phone') || null };
    btn.disabled = true;
    var res;
    if (id) {
      res = await guardedUpdate('outlets', data, 'id', id);
    } else {
      data.company_id = profile.company_id;
      res = await window.sb.from('outlets').insert(data);
    }
    if (res.error || (id && (!res.data || !res.data.length))) {
      btn.disabled = false;
      showFlash('Could not save outlet. Please try again.', 'error');
      return;
    }
    showFlash(id ? 'Outlet updated.' : 'Outlet created.', 'success');
    document.getElementById('outletFormHost').innerHTML = '';
    refreshAll();
  }

  // ---------- Drivers ----------

  function driverFormHtml(d, saveAction, saveLabel) {
    return '<div class="inline-panel" data-panel><div class="form-grid">' +
      fieldHtml('Driver name *', inputHtml('driver-name', d && d.name, 'Full name')) +
      fieldHtml('Phone', inputHtml('driver-phone', d && d.phone, 'Phone number')) +
      fieldHtml('License number', inputHtml('driver-license', d && d.license_number, 'License no.')) +
      '</div>' + panelActions(saveAction, saveLabel) + '</div>';
  }

  function renderDrivers() {
    driverListEl.innerHTML = cache.drivers.length ? cache.drivers.map(function (d) {
      var linkedUser = cache.profiles.find(function (p) { return p.driver_id === d.id; });
      var defaultVehicle = cache.vehicles.find(function (v) { return v.driver_id === d.id; });
      var chips = '';
      if (linkedUser) chips += '<span class="chip">🔑 ' + escapeHtml(linkedUser.name || linkedUser.email) + '</span>';
      if (defaultVehicle) chips += '<span class="chip">🚐 ' + escapeHtml(defaultVehicle.vehicle_name) + '</span>';
      return '<div class="card" data-id="' + escapeHtml(d.id) + '">' +
        '<div class="request-top"><strong>' + escapeHtml(d.name) + '</strong>' + activeBadge(d.active) + '</div>' +
        (d.phone ? '<div class="meta">📞 ' + escapeHtml(d.phone) + '</div>' : '') +
        (d.license_number ? '<div class="meta">🪪 ' + escapeHtml(d.license_number) + '</div>' : '') + chips +
        '<div class="request-actions">' +
          '<button class="btn btn-outline" type="button" data-action="edit-driver">Edit</button>' +
          '<button class="btn btn-outline" type="button" data-action="toggle-driver">' + (d.active ? 'Deactivate' : 'Activate') + '</button>' +
        '</div></div>';
    }).join('') : '<div class="empty-state">No drivers yet. Add your first driver above.</div>';
  }

  async function saveDriver(scope, id, btn) {
    var name = readPanel(scope, 'driver-name');
    if (!name) { showFlash('Please enter the driver name.', 'error'); return; }
    var data = { name: name, phone: readPanel(scope, 'driver-phone') || null, license_number: readPanel(scope, 'driver-license') || null };
    btn.disabled = true;
    var res;
    if (id) {
      res = await guardedUpdate('drivers', data, 'id', id);
    } else {
      data.company_id = profile.company_id;
      res = await window.sb.from('drivers').insert(data);
    }
    if (res.error || (id && (!res.data || !res.data.length))) {
      btn.disabled = false;
      showFlash('Could not save driver. Please try again.', 'error');
      return;
    }
    showFlash(id ? 'Driver updated.' : 'Driver created.', 'success');
    document.getElementById('driverFormHost').innerHTML = '';
    refreshAll();
  }

  // ---------- Vehicles ----------

  function vehicleFormHtml(v, saveAction, saveLabel) {
    var statuses = ['available', 'offline', 'maintenance'];
    if (v && v.status === 'busy') statuses.unshift('busy'); // keep current value selectable
    var statusOptions = statuses.map(function (s) {
      return '<option value="' + s + '"' + (v && v.status === s ? ' selected' : '') + '>' + STATUS_LABELS[s] + '</option>';
    }).join('');
    var html = '<div class="inline-panel" data-panel><div class="form-grid">' +
      fieldHtml('Vehicle name *', inputHtml('vehicle-name', v && v.vehicle_name, 'e.g. Van 1')) +
      fieldHtml('Plate number *', inputHtml('vehicle-plate', v && v.plate_number, 'e.g. ABC-123'));
    if (v) {
      html += fieldHtml('Status', '<select data-role="vehicle-status">' + statusOptions + '</select>') +
        fieldHtml('Default driver', '<select data-role="vehicle-driver">' +
          selectOptions(cache.drivers.filter(function (d) { return d.active; }), v.driver_id, 'No default driver', function (d) { return d.name; }) +
          '</select>');
    }
    return html + '</div>' + panelActions(saveAction, saveLabel) + '</div>';
  }

  function renderVehicles() {
    vehicleListEl.innerHTML = cache.vehicles.length ? cache.vehicles.map(function (v) {
      var driver = cache.drivers.find(function (d) { return d.id === v.driver_id; });
      return '<div class="card" data-id="' + escapeHtml(v.id) + '">' +
        '<div class="request-top"><strong>' + escapeHtml(v.vehicle_name) + '</strong>' +
        '<span>' + statusBadge(v.status) + ' ' + activeBadge(v.active) + '</span></div>' +
        '<div class="meta">🔖 ' + escapeHtml(v.plate_number) + '</div>' +
        (driver ? '<div class="meta">👤 ' + escapeHtml(driver.name) + '</div>' : '') +
        '<div class="request-actions">' +
          '<button class="btn btn-outline" type="button" data-action="edit-vehicle">Edit</button>' +
          '<button class="btn btn-outline" type="button" data-action="toggle-vehicle">' + (v.active ? 'Deactivate' : 'Activate') + '</button>' +
        '</div></div>';
    }).join('') : '<div class="empty-state">No vehicles yet. Add your first vehicle above.</div>';
  }

  async function saveVehicle(scope, id, btn) {
    var name = readPanel(scope, 'vehicle-name');
    var plate = readPanel(scope, 'vehicle-plate');
    if (!name || !plate) { showFlash('Please enter the vehicle name and plate number.', 'error'); return; }
    var data = { vehicle_name: name, plate_number: plate };
    var v = id && cache.vehicles.find(function (x) { return x.id === id; });
    if (v) {
      data.status = readPanel(scope, 'vehicle-status') || v.status;
      data.driver_id = readPanel(scope, 'vehicle-driver') || null;
      if (v.status === 'busy' && data.status === 'maintenance' &&
          !window.confirm('This vehicle is busy on a job. Set it to maintenance anyway?')) {
        return;
      }
    }
    btn.disabled = true;
    var res;
    if (id) {
      res = await guardedUpdate('vehicles', data, 'id', id);
    } else {
      data.company_id = profile.company_id;
      res = await window.sb.from('vehicles').insert(data);
    }
    if (res.error) {
      btn.disabled = false;
      if (res.error.code === '23505') {
        showFlash('A vehicle with this plate number already exists.', 'error');
      } else if ((res.error.message || '').indexOf('active job') !== -1) {
        showFlash('This vehicle still has an active job. Complete or cancel the job first.', 'error');
      } else {
        showFlash('Could not save vehicle. Please try again.', 'error');
      }
      return;
    }
    if (id && (!res.data || !res.data.length)) {
      btn.disabled = false;
      showFlash('Could not save vehicle. Please try again.', 'error');
      return;
    }
    showFlash(id ? 'Vehicle updated.' : 'Vehicle created.', 'success');
    document.getElementById('vehicleFormHost').innerHTML = '';
    refreshAll();
  }

  async function toggleEntity(table, listName, id, btn, labels) {
    var item = cache[listName].find(function (x) { return x.id === id; });
    if (!item) return;
    btn.disabled = true;
    var res = await guardedUpdate(table, { active: !item.active }, 'id', id);
    if (res.error || !res.data || !res.data.length) {
      btn.disabled = false;
      showFlash('Could not update. Please try again.', 'error');
      return;
    }
    showFlash(item.active ? labels[1] : labels[0], 'success');
    refreshAll();
  }

  // ---------- Recent jobs ----------

  async function loadJobs() {
    var q = window.sb
      .from('vehicle_requests')
      .select('id, status, pickup_location, dropoff_location, customer_name, customer_contact, notes, cancellation_reason, created_at, accepted_at, started_at, completed_at, cancelled_at, outlets(name), drivers(name), vehicles(vehicle_name, plate_number)');
    if (jobFilter !== 'all') q = q.eq('status', jobFilter);
    var res = await q.order('updated_at', { ascending: false }).limit(20);

    if (res.error) {
      jobListEl.innerHTML = '<div class="empty-state">Could not load jobs. Please refresh.</div>';
      return;
    }
    if (!res.data.length) {
      jobListEl.innerHTML = '<div class="empty-state">No recent jobs.</div>';
      return;
    }
    jobListEl.innerHTML = res.data.map(function (r) {
      var extra = '';
      if (r.drivers && r.drivers.name) extra += '<span class="chip">👤 ' + escapeHtml(r.drivers.name) + '</span>';
      if (r.vehicles) extra += '<span class="chip">🚐 ' + escapeHtml(r.vehicles.vehicle_name) + ' · ' + escapeHtml(r.vehicles.plate_number) + '</span>';
      if (r.cancellation_reason) extra += '<div class="meta">💬 Reason: ' + escapeHtml(r.cancellation_reason) + '</div>';
      extra += timesHtml(r);
      var outletName = r.outlets && r.outlets.name;
      return requestCardHtml(r, {
        topLine: outletName ? '🏬 ' + escapeHtml(outletName) : '',
        extraHtml: extra,
      });
    }).join('');
  }

  // ---------- Event wiring ----------

  userListEl.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var card = btn.closest('.card');
    var id = card.getAttribute('data-id');
    var action = btn.getAttribute('data-action');
    if (action === 'edit-user') {
      var u = cache.profiles.find(function (p) { return p.user_id === id; });
      if (u) openUserPanel(card, u);
    } else if (action === 'toggle-user') toggleUser(id, btn);
    else if (action === 'save-user') saveUser(card, id, btn);
    else if (action === 'close-panel') closePanels(userListEl);
  });

  // Show/hide the outlet/driver link selects to match the chosen role.
  userListEl.addEventListener('change', function (e) {
    if (!e.target.matches('[data-role="user-role"]')) return;
    var panel = e.target.closest('[data-panel]');
    var role = e.target.value;
    panel.querySelector('[data-role="user-outlet"]').closest('.field').toggleAttribute('hidden', role !== 'outlet');
    panel.querySelector('[data-role="user-driver"]').closest('.field').toggleAttribute('hidden', role !== 'driver');
  });

  function wireSection(sectionId, formHostId, formHtmlFn, listEl, cacheName, table, actions) {
    document.getElementById(sectionId).addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      var host = document.getElementById(formHostId);
      var card = btn.closest('.card[data-id]');
      var id = card ? card.getAttribute('data-id') : null;

      if (action === 'new-' + actions.kind) {
        closePanels(listEl);
        host.innerHTML = host.innerHTML ? '' : formHtmlFn(null, 'create-' + actions.kind, actions.createLabel);
      } else if (action === 'edit-' + actions.kind) {
        host.innerHTML = '';
        closePanels(listEl);
        var item = cache[cacheName].find(function (x) { return x.id === id; });
        if (item) card.insertAdjacentHTML('beforeend', formHtmlFn(item, 'update-' + actions.kind, 'Save'));
      } else if (action === 'create-' + actions.kind) {
        actions.save(host, null, btn);
      } else if (action === 'update-' + actions.kind) {
        actions.save(card, id, btn);
      } else if (action === 'toggle-' + actions.kind) {
        toggleEntity(table, cacheName, id, btn, actions.toggleLabels);
      } else if (action === 'close-panel') {
        host.innerHTML = '';
        closePanels(listEl);
      }
    });
  }

  wireSection('outletsSection', 'outletFormHost', outletFormHtml, outletListEl, 'outlets', 'outlets',
    { kind: 'outlet', createLabel: 'Create Outlet', save: saveOutlet, toggleLabels: ['Outlet activated.', 'Outlet deactivated.'] });
  wireSection('driversSection', 'driverFormHost', driverFormHtml, driverListEl, 'drivers', 'drivers',
    { kind: 'driver', createLabel: 'Create Driver', save: saveDriver, toggleLabels: ['Driver activated.', 'Driver deactivated.'] });
  wireSection('vehiclesSection', 'vehicleFormHost', vehicleFormHtml, vehicleListEl, 'vehicles', 'vehicles',
    { kind: 'vehicle', createLabel: 'Create Vehicle', save: saveVehicle, toggleLabels: ['Vehicle activated.', 'Vehicle deactivated.'] });

  document.getElementById('jobFilters').addEventListener('click', function (e) {
    var btn = e.target.closest('.filter-btn');
    if (!btn) return;
    jobFilter = btn.getAttribute('data-status');
    document.querySelectorAll('#jobFilters .filter-btn').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    loadJobs();
  });

  document.getElementById('refreshAll').addEventListener('click', refreshAll);
  refreshAll();
}
