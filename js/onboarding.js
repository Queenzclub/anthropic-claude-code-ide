// Company onboarding UI (Stage 4B-2) — App Admin only.
//
// Drives the create-company / send-admin-setup-email Edge Functions with the
// logged-in App Admin's session (supabase-js attaches the bearer + anon key;
// no service-role anywhere in the browser). All onboarding STATE shown here
// comes from Migration 24's company_onboarding row / status RPC — never from
// assumptions. A successful email API call is always worded "requested",
// never "delivered".
//
// Resilience:
//  * idempotency_key is generated client-side, persisted in sessionStorage
//    with the form draft, and reused verbatim on every retry of the same
//    submission. Only editing the form mints a new key.
//  * On reload mid-submission the draft reconnects to the authoritative
//    onboarding row (found by idempotency_key) instead of re-submitting.
//  * onboarding_in_progress / non-terminal states are polled read-only via
//    get_company_onboarding_status every 5s, capped at 2 minutes.
// The draft never contains tokens, passwords or secrets — only form fields.

var OB_DRAFT_KEY = 'fbp_onboarding_draft';
var OB_CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
var OB_POLL_MS = window.__OB_POLL_MS || 5000;          // test override
var OB_POLL_MAX_MS = window.__OB_POLL_MAX_MS || 120000; // 2 minutes

// Read-only columns only — never processing_token.
var OB_COLS = 'id, company_id, state, setup_email_status, setup_email_attempt_count, ' +
  'error_code, idempotency_key, company_name, company_code, timezone, admin_name, ' +
  'admin_email_normalized, processing_expires_at, setup_started_at, ' +
  'admin_setup_completed_at, created_at, updated_at, completed_at';

var OB_ERROR_MESSAGES = {
  invalid_input: 'Please check the form — one of the fields is invalid.',
  company_code_exists: 'This company code is already in use.',
  email_already_linked: 'This email is already linked to an account. Use a different email.',
  onboarding_in_progress: 'This onboarding is already being processed. Please wait…',
  idempotency_conflict: 'This onboarding was started by another platform admin or with different details.',
  invitation_failed: 'The setup email could not be requested. The company data is safe — retry when ready.',
  setup_email_failed: 'The setup email could not be requested. You can send it again.',
  retry_required: 'Something went wrong. Nothing was lost — use Retry to continue.',
  onboarding_failed: 'Something went wrong. Nothing was lost — use Retry to continue.',
  not_allowed: 'You are not allowed to do this.',
  admin_not_linked: 'The first admin is not linked yet — finish or retry the onboarding first.',
  network_error: 'Network problem. Your request may still be processing — refresh to check.',
};
function obMessage(code) {
  return OB_ERROR_MESSAGES[code] || OB_ERROR_MESSAGES.onboarding_failed;
}

// Deployment-mismatch guard: true when the onboarding backend (Migration 24/25
// objects) is not present live. Prevents exposing the Create Company UI or
// querying missing objects when the frontend ships ahead of the backend.
function obBackendMissing(err) {
  if (!err) return false;
  var code = err.code || '';
  var msg = (err.message || '').toLowerCase();
  return code === 'PGRST205' || code === '42P01' ||
    msg.indexOf('does not exist') !== -1 ||
    msg.indexOf('could not find the table') !== -1 ||
    msg.indexOf("relation") !== -1 && msg.indexOf('does not exist') !== -1;
}

// A compact, searchable set of IANA zones (native datalist filters as you type).
var OB_TIMEZONES = [
  'Indian/Maldives', 'Asia/Colombo', 'Asia/Kolkata', 'Asia/Karachi', 'Asia/Dubai',
  'Asia/Riyadh', 'Asia/Qatar', 'Asia/Kuwait', 'Asia/Bangkok', 'Asia/Jakarta',
  'Asia/Kuala_Lumpur', 'Asia/Singapore', 'Asia/Manila', 'Asia/Hong_Kong',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Australia/Perth', 'Australia/Sydney',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Istanbul', 'Europe/Moscow', 'Africa/Cairo', 'Africa/Nairobi',
  'Africa/Johannesburg', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Sao_Paulo', 'Pacific/Auckland', 'UTC',
];

function initOnboarding(ctx) {
  var host = document.getElementById('createCompanyHost');
  if (!host || !window.sb) return;

  var state = {
    draft: loadDraft(),
    polling: null,        // { timer, started, onboardingId }
    rows: [],             // latest company_onboarding rows
    busy: false,
  };

  // ---------- draft persistence (sessionStorage; no secrets ever) ----------

  function loadDraft() {
    try {
      var raw = sessionStorage.getItem(OB_DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function saveDraft(d) {
    state.draft = d;
    try {
      if (d) sessionStorage.setItem(OB_DRAFT_KEY, JSON.stringify(d));
      else sessionStorage.removeItem(OB_DRAFT_KEY);
    } catch (e) { /* ignore */ }
  }
  function newKey() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, function () {
          return (Math.random() * 16 | 0).toString(16);
        });
  }

  // Warn before leaving only while there are unsaved changes or an in-flight
  // submission — never after success (draft cleared).
  window.addEventListener('beforeunload', function (e) {
    var d = state.draft;
    if (d && (d.state === 'submitting' || (d.state === 'editing' && hasContent(d.fields)))) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  function hasContent(f) {
    return !!(f && (f.company_name || f.company_code || f.first_admin_name || f.first_admin_email));
  }

  // ---------- form ----------

  function fieldValue(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }
  function readForm() {
    return {
      company_name: fieldValue('obName'),
      company_code: fieldValue('obCode').toUpperCase(),
      timezone: fieldValue('obTz') || 'Indian/Maldives',
      first_admin_name: fieldValue('obAdminName'),
      first_admin_email: fieldValue('obAdminEmail').toLowerCase(),
    };
  }

  function renderForm() {
    var d = state.draft;
    var f = (d && d.fields) || {};
    var tzOptions = OB_TIMEZONES.map(function (z) {
      return '<option value="' + escapeHtml(z) + '"></option>';
    }).join('');
    host.innerHTML =
      '<div class="card">' +
        '<div class="form-grid">' +
          '<div class="field"><label for="obName">Company name</label>' +
            '<input id="obName" value="' + escapeHtml(f.company_name || '') + '" placeholder="e.g. Glow Trading"></div>' +
          '<div class="field"><label for="obCode">Company code</label>' +
            '<input id="obCode" value="' + escapeHtml(f.company_code || '') + '" placeholder="e.g. GLOW2026" autocapitalize="characters"></div>' +
          '<div class="field"><label for="obTz">Timezone</label>' +
            '<input id="obTz" list="obTzList" value="' + escapeHtml(f.timezone || 'Indian/Maldives') + '" placeholder="Indian/Maldives">' +
            '<datalist id="obTzList">' + tzOptions + '</datalist></div>' +
          '<div class="field"><label for="obAdminName">First Company Admin name</label>' +
            '<input id="obAdminName" value="' + escapeHtml(f.first_admin_name || '') + '" placeholder="e.g. Aisha Ahmed"></div>' +
          '<div class="field"><label for="obAdminEmail">First Company Admin email</label>' +
            '<input id="obAdminEmail" type="email" value="' + escapeHtml(f.first_admin_email || '') + '" placeholder="admin@company.com"></div>' +
        '</div>' +
        '<p class="muted small">The admin sets their own password through a secure email link — no password is entered here.</p>' +
        '<div id="obFormMsg"></div>' +
        '<div class="request-actions">' +
          '<button id="obSubmit" class="btn btn-primary" type="button">Create Company</button>' +
          '<button id="obCancel" class="btn btn-outline" type="button">Clear</button>' +
        '</div>' +
      '</div>' +
      '<div id="obProgress"></div>';

    var codeEl = document.getElementById('obCode');
    codeEl.addEventListener('input', function () {
      var pos = codeEl.selectionStart;
      codeEl.value = codeEl.value.toUpperCase();
      try { codeEl.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
      onEdit();
    });
    ['obName', 'obTz', 'obAdminName', 'obAdminEmail'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', onEdit);
    });
    document.getElementById('obSubmit').addEventListener('click', submit);
    document.getElementById('obCancel').addEventListener('click', function () {
      saveDraft(null);            // explicit cancellation clears the draft
      renderForm();
    });
  }

  // Editing after a failure mints a FRESH key for the next new submission;
  // plain editing keeps (or creates) the current editing draft + key.
  function onEdit() {
    var d = state.draft;
    if (d && d.state === 'submitting') return;   // form is disabled anyway
    var key = (d && d.state === 'editing' && d.key) ? d.key : newKey();
    saveDraft({ fields: readForm(), key: key, state: 'editing' });
  }

  function formMsg(html, cls) {
    var el = document.getElementById('obFormMsg');
    if (el) el.innerHTML = html ? '<div class="alert ' + (cls || 'alert-error') + '">' + html + '</div>' : '';
  }
  function setFormBusy(busy, label) {
    state.busy = busy;
    var btn = document.getElementById('obSubmit');
    if (btn) { btn.disabled = busy; btn.textContent = busy ? (label || 'Creating company…') : 'Create Company'; }
    var cancel = document.getElementById('obCancel');
    if (cancel) cancel.disabled = busy;
  }

  function validate(f) {
    if (!f.company_name) return 'Please enter the company name.';
    if (!OB_CODE_RE.test(f.company_code)) {
      return 'Company code must be 3–32 characters: capital letters, digits and dashes, starting with a letter or digit.';
    }
    if (!f.timezone) return 'Please choose a timezone.';
    if (!f.first_admin_name) return 'Please enter the first admin’s name.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.first_admin_email)) return 'Please enter a valid admin email.';
    return null;
  }

  // ---------- Edge Function calls ----------

  async function callFn(name, body) {
    var res;
    try {
      res = await window.sb.functions.invoke(name, { body: body });
    } catch (e) {
      return { ok: false, code: 'network_error' };
    }
    if (!res.error) return { ok: true, data: res.data };
    var code = 'onboarding_failed';
    try {
      if (res.error.context && res.error.context.json) {
        var j = await res.error.context.json();
        if (j && j.error) code = j.error;
      }
    } catch (e) { /* keep generic */ }
    return { ok: false, code: code };
  }

  // ---------- submission ----------

  async function submit() {
    if (state.busy) return;   // duplicate-submit prevention
    var f = readForm();
    var bad = validate(f);
    if (bad) { formMsg(escapeHtml(bad)); return; }

    // Reuse the draft's key when this is the same (restored) submission;
    // a fresh edit already minted a fresh key via onEdit.
    var d = state.draft;
    var key = (d && d.key) ? d.key : newKey();
    saveDraft({ fields: f, key: key, state: 'submitting', submitted_at: Date.now() });

    formMsg('');
    setFormBusy(true);
    var r = await callFn('create-company', {
      company_name: f.company_name, company_code: f.company_code, timezone: f.timezone,
      first_admin_name: f.first_admin_name, first_admin_email: f.first_admin_email,
      idempotency_key: key,
    });
    setFormBusy(false);

    if (r.ok) {
      renderSuccess(r.data);
      saveDraft(null);                       // confirmed success clears the draft
      refreshRows();
      if (window.__appAdminRefresh) window.__appAdminRefresh();
      return;
    }
    if (r.code === 'onboarding_in_progress' || r.code === 'network_error') {
      // Do NOT re-call create-company: reconnect read-only + poll.
      saveDraft({ fields: f, key: key, state: 'submitting', submitted_at: Date.now() });
      formMsg(escapeHtml(obMessage(r.code)), 'alert-warn');
      reconnect(key);
      return;
    }
    saveDraft({ fields: f, key: key, state: 'failed' });
    formMsg(escapeHtml(obMessage(r.code)) +
      (r.code === 'retry_required' || r.code === 'invitation_failed' || r.code === 'onboarding_failed'
        ? ' <button id="obRetry" class="btn btn-outline btn-small" type="button">Retry</button>' : ''));
    var retryBtn = document.getElementById('obRetry');
    if (retryBtn) retryBtn.addEventListener('click', submit);   // same key: draft state is failed, submit reuses d.key
  }

  function renderSuccess(data) {
    var prog = document.getElementById('obProgress');
    var email = data.setup_email_status === 'requested'
      ? '✉️ Setup email requested for ' + escapeHtml(data.admin_email)
      : '⚠️ Setup email ' + escapeHtml(data.setup_email_status) + ' — you can send it again from the company detail.';
    if (prog) prog.innerHTML =
      '<div class="alert alert-success">✅ Company <strong>' + escapeHtml(data.company_code) +
      '</strong> created and active.<br>' + email + '</div>';
    renderFormFieldsCleared();
  }
  function renderFormFieldsCleared() {
    ['obName', 'obCode', 'obAdminName', 'obAdminEmail'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.value = '';
    });
  }

  // ---------- reconnect + polling (read-only) ----------

  // Finds the authoritative onboarding row for a submission key (fallback: the
  // admin email of the restored draft), then polls its status.
  async function reconnect(key) {
    var q = await window.sb.from('company_onboarding').select(OB_COLS)
      .eq('idempotency_key', key).maybeSingle();
    var row = (!q.error && q.data) ? q.data : null;
    if (!row && state.draft && state.draft.fields && state.draft.fields.first_admin_email) {
      var q2 = await window.sb.from('company_onboarding').select(OB_COLS)
        .eq('admin_email_normalized', state.draft.fields.first_admin_email)
        .order('created_at', { ascending: false }).limit(1);
      if (!q2.error && q2.data && q2.data.length) row = q2.data[0];
    }
    if (!row) {
      // begin never committed: restore the form + SAME key for a manual resubmit.
      var d = state.draft || {};
      saveDraft({ fields: d.fields, key: key, state: 'editing' });
      formMsg('The submission did not start. Your details are restored — submit again when ready.', 'alert-warn');
      return;
    }
    if (state.draft) saveDraft(Object.assign({}, state.draft, { onboarding_id: row.id }));
    handleStatus(row.id, { state: row.state, setup_email_status: row.setup_email_status,
      company_code: row.company_code, error_code: row.error_code });
  }

  function handleStatus(onboardingId, s) {
    if (s.state === 'completed') {
      stopPolling();
      renderSuccess({ company_code: s.company_code || '', setup_email_status: s.setup_email_status,
        admin_email: (state.draft && state.draft.fields && state.draft.fields.first_admin_email) || '' });
      saveDraft(null);
      refreshRows();
      if (window.__appAdminRefresh) window.__appAdminRefresh();
      return;
    }
    if (s.state === 'failed_retriable') {
      stopPolling();
      if (state.draft) saveDraft(Object.assign({}, state.draft, { state: 'failed' }));
      formMsg(escapeHtml(obMessage(s.error_code || 'retry_required')) +
        ' <button id="obRetry" class="btn btn-outline btn-small" type="button">Retry</button>');
      var b = document.getElementById('obRetry');
      if (b) b.addEventListener('click', submit);
      refreshRows();
      return;
    }
    if (s.state === 'failed_terminal') {
      stopPolling();
      if (state.draft) saveDraft(Object.assign({}, state.draft, { state: 'failed' }));
      formMsg(escapeHtml(obMessage(s.error_code || 'onboarding_failed')));
      refreshRows();
      return;
    }
    startPolling(onboardingId);   // still in progress
  }

  function startPolling(onboardingId) {
    if (state.polling && state.polling.onboardingId === onboardingId) return;   // already polling it
    stopPolling();
    setFormBusy(true, 'Processing…');
    formMsg('⏳ Onboarding is being processed…', 'alert-warn');
    state.polling = { onboardingId: onboardingId, started: Date.now(), timer: null };
    state.polling.timer = setInterval(async function () {
      if (Date.now() - state.polling.started > OB_POLL_MAX_MS) {
        stopPolling();
        formMsg('Processing is taking longer than expected. Refresh or try again.', 'alert-warn');
        return;
      }
      var r;
      try { r = await window.sb.rpc('get_company_onboarding_status', { p_onboarding: onboardingId }); }
      catch (e) { r = { error: e }; }
      if (r.error || !r.data) return;   // transient read problem: keep polling until timeout
      handleStatus(onboardingId, r.data);
    }, OB_POLL_MS);
  }
  function stopPolling() {
    if (state.polling && state.polling.timer) clearInterval(state.polling.timer);
    state.polling = null;
    setFormBusy(false);
  }

  // ---------- onboarding rows: list badges + detail timeline ----------

  async function refreshRows() {
    var q = await window.sb.from('company_onboarding').select(OB_COLS)
      .order('created_at', { ascending: false });
    state.rows = (!q.error && q.data) ? q.data : [];
    decorateList();
  }

  function latestForCompany(companyId) {
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].company_id === companyId) return state.rows[i];   // rows are newest-first
    }
    return null;
  }

  function leaseActive(row) {
    return row.processing_expires_at && new Date(row.processing_expires_at).getTime() > Date.now();
  }

  function obBadge(row) {
    if (!row) return '';
    if (row.state === 'failed_terminal') return '<span class="badge badge-maintenance">Onboarding Failed</span>';
    if (row.state === 'failed_retriable') return '<span class="badge badge-pending">Onboarding Failed — Retry</span>';
    if (row.state !== 'completed' && leaseActive(row)) return '<span class="badge badge-busy">Onboarding In Progress</span>';
    if (row.state !== 'completed') return '<span class="badge badge-pending">Onboarding Incomplete</span>';
    return '';
  }

  // Called by app-admin.js after it renders the company list.
  function decorateList() {
    var cards = document.querySelectorAll('#companyList .company-card');
    for (var i = 0; i < cards.length; i++) {
      var id = cards[i].getAttribute('data-id');
      var row = latestForCompany(id);
      var badge = obBadge(row);
      var slot = cards[i].querySelector('.ob-badge-slot');
      if (!slot) {
        slot = document.createElement('div');
        slot.className = 'ob-badge-slot';
        var top = cards[i].querySelector('.card-top');
        if (top) top.insertAdjacentElement('afterend', slot); else cards[i].appendChild(slot);
      }
      slot.innerHTML = badge;
    }
  }

  function stepHtml(icon, label, cls) {
    return '<div class="ob-step ob-' + cls + '"><span class="ob-icon">' + icon + '</span>' + label + '</div>';
  }

  // Timeline strictly from Migration 24 state + setup_email_status. A
  // successful email call is shown as REQUESTED — delivery is never claimed.
  function timelineHtml(row) {
    var order = ['requested', 'company_created', 'resolving_auth_user', 'linking_profile', 'admin_linked', 'completed'];
    var idx = order.indexOf(row.state);
    var failed = row.state === 'failed_retriable' || row.state === 'failed_terminal';
    function at(i) { return idx >= i || row.state === 'completed'; }
    var html = '<div class="ob-timeline">';
    html += stepHtml(at(1) ? '✅' : '○', 'Company created', at(1) ? 'done' : 'pending');
    html += stepHtml(at(3) ? '✅' : '○', 'Admin Auth account resolved', at(3) ? 'done' : 'pending');
    html += stepHtml(at(4) ? '✅' : '○', 'Admin profile linked', at(4) ? 'done' : 'pending');
    if (row.setup_email_status === 'requested') {
      html += stepHtml('✉️', 'Setup email requested (' + escapeHtml(row.setup_email_attempt_count) + '×)', 'done');
    } else if (row.setup_email_status === 'failed' || row.setup_email_status === 'uncertain') {
      html += stepHtml('⚠️', 'Setup email ' + escapeHtml(row.setup_email_status) + ' — send it again below', 'warn');
    } else {
      html += stepHtml('○', 'Setup email not requested yet', 'pending');
    }
    html += stepHtml(row.state === 'completed' ? '✅' : '○', 'Company activated', row.state === 'completed' ? 'done' : 'pending');
    // First-admin password setup is DERIVED (Migration 25): once the company is
    // active, the admin is still inactive until they finish setting a password.
    if (row.state === 'completed') {
      if (row.admin_setup_completed_at) {
        html += stepHtml('✅', 'Account setup completed', 'done');
      } else {
        html += stepHtml('⏳', 'Account setup pending', 'warn');
      }
    }
    if (failed) {
      html += stepHtml('❌', (row.state === 'failed_terminal' ? 'Failed' : 'Failed — retry available') +
        (row.error_code ? ': ' + escapeHtml(obMessage(row.error_code)) : ''), 'fail');
    } else if (row.state !== 'completed' && leaseActive(row)) {
      html += stepHtml('⏳', 'Onboarding in progress…', 'warn');
    }
    return html + '</div>';
  }

  // Called by app-admin.js after it renders a company detail.
  function renderDetailTimeline(companyId) {
    var hostEl = document.getElementById('onboardingHost');
    if (!hostEl) return;
    var row = latestForCompany(companyId);
    if (!row) { hostEl.innerHTML = ''; return; }
    var actions = '';
    if (row.state === 'failed_retriable') {
      actions += '<button class="btn btn-primary btn-small" type="button" data-ob-action="retry" data-ob-id="' + escapeHtml(row.id) + '">Retry Onboarding</button>';
    }
    if (row.state === 'admin_linked' || row.state === 'completed') {
      actions += '<button class="btn btn-outline btn-small" type="button" data-ob-action="resend" data-ob-id="' + escapeHtml(row.id) + '">Send Setup Email Again</button>';
    }
    hostEl.innerHTML =
      '<div class="detail-group"><h4>🧭 Onboarding</h4>' + timelineHtml(row) +
      '<div id="obDetailMsg"></div>' +
      (actions ? '<div class="request-actions">' + actions + '</div>' : '') + '</div>';
  }

  function detailMsg(html, cls) {
    var el = document.getElementById('obDetailMsg');
    if (el) el.innerHTML = html ? '<div class="alert ' + (cls || 'alert-error') + '">' + html + '</div>' : '';
  }

  // Retry from the detail view: reuse the row's ORIGINAL idempotency key +
  // stored payload. Only the original requesting App Admin can retry (a
  // different admin gets idempotency_conflict from the backend).
  async function retryFromRow(rowId) {
    var row = null;
    for (var i = 0; i < state.rows.length; i++) if (state.rows[i].id === rowId) row = state.rows[i];
    if (!row || state.busy) return;
    detailMsg('⏳ Retrying onboarding…', 'alert-warn');
    state.busy = true;
    var r = await callFn('create-company', {
      company_name: row.company_name, company_code: row.company_code, timezone: row.timezone,
      first_admin_name: row.admin_name, first_admin_email: row.admin_email_normalized,
      idempotency_key: row.idempotency_key,
    });
    state.busy = false;
    // Re-render the timeline FIRST (it replaces the message host), then show
    // the outcome so it survives the re-render.
    await refreshRows();
    renderDetailTimeline(row.company_id);
    if (r.ok) {
      detailMsg('✅ Onboarding completed. Setup email ' + escapeHtml(r.data.setup_email_status) + '.', 'alert-success');
    } else if (r.code === 'onboarding_in_progress') {
      detailMsg(escapeHtml(obMessage(r.code)), 'alert-warn');
      startPolling(row.id);
    } else {
      detailMsg(escapeHtml(obMessage(r.code)));
    }
    if (window.__appAdminRefresh) window.__appAdminRefresh();
  }

  async function resendFromRow(rowId) {
    var row = null;
    for (var i = 0; i < state.rows.length; i++) if (state.rows[i].id === rowId) row = state.rows[i];
    if (!row || state.busy) return;
    detailMsg('⏳ Requesting setup email…', 'alert-warn');
    state.busy = true;
    var r = await callFn('send-admin-setup-email', { onboarding_id: row.id });
    state.busy = false;
    await refreshRows();
    renderDetailTimeline(row.company_id);   // re-render first; message survives
    if (r.ok && r.data.setup_email_status === 'requested') {
      detailMsg('✉️ Setup email requested again.', 'alert-success');
    } else if (r.ok) {
      detailMsg('⚠️ Setup email ' + escapeHtml(r.data.setup_email_status) + '. You can try again.', 'alert-warn');
    } else {
      detailMsg(escapeHtml(obMessage(r.code)));
    }
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-ob-action]') : null;
    if (!el) return;
    var action = el.getAttribute('data-ob-action');
    var id = el.getAttribute('data-ob-id');
    if (action === 'retry') retryFromRow(id);
    if (action === 'resend') resendFromRow(id);
  });

  // Hooks used by app-admin.js after its own renders.
  window.onboardingDecorate = decorateList;
  window.onboardingDetail = renderDetailTimeline;

  // ---------- init: probe backend, then render + reload recovery ----------
  // Probe the onboarding backend FIRST. If Migration 24/25 objects are not live
  // (frontend shipped ahead of backend), keep the Create Company UI disabled and
  // do not query missing objects — degrade safely instead of exposing a broken
  // half-feature.
  (async function () {
    var probe = await window.sb.from('company_onboarding').select('id').limit(1);
    if (probe.error && obBackendMissing(probe.error)) {
      host.innerHTML =
        '<div class="detail-group"><h4>🏢 Create Company</h4>' +
        '<p class="muted small">Company onboarding is not available right now.</p></div>';
      return;   // no form, no further queries, hooks stay no-op on empty rows
    }

    renderForm();
    refreshRows();

    var d = state.draft;
    if (d && d.state === 'submitting' && d.key) {
      // Reload mid-submission: reconnect read-only with the SAME key.
      formMsg('⏳ Reconnecting to your in-flight onboarding…', 'alert-warn');
      reconnect(d.key);
    } else if (d && d.state === 'failed') {
      formMsg(escapeHtml(obMessage('retry_required')) +
        ' <button id="obRetry" class="btn btn-outline btn-small" type="button">Retry</button>');
      var rb = document.getElementById('obRetry');
      if (rb) rb.addEventListener('click', submit);
    }
  })();
}
