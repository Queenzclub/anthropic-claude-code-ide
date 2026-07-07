// Fleet Board Pro — live in-app notifications (Supabase Realtime).
//
// Scope is enforced twice: a channel filter narrows the stream, and the
// SAME row-level security that governs normal reads also governs which
// realtime rows a user receives. So a driver only ever hears about open
// or personally-targeted requests in their own company, and an outlet
// only hears about its own deliveries. No service_role, no cross-company
// or cross-outlet leakage.
//
// Realtime only runs while the app is open (a tab/PWA in the foreground
// or background). True push while the app is fully closed would need a
// Supabase Edge Function + Web Push and is intentionally left for later.
//
// If the Supabase client has no realtime channel support, every function
// here degrades to a no-op so the dashboards still work.

function fleetSubscribe(channelName, changeConfig, handler) {
  if (!window.sb || typeof window.sb.channel !== 'function') return null;
  try {
    return window.sb
      .channel(channelName)
      .on('postgres_changes', changeConfig, handler)
      .subscribe();
  } catch (e) {
    return null;
  }
}

// Drivers: toast when a new request they may take is created.
// onNew() (optional) refreshes the Available Requests list.
function initDriverNotifications(profile, onNew) {
  if (!profile || !profile.company_id) return null;
  return fleetSubscribe(
    'driver-new-requests-' + profile.company_id,
    {
      event: 'INSERT',
      schema: 'public',
      table: 'vehicle_requests',
      filter: 'company_id=eq.' + profile.company_id,
    },
    function (payload) {
      var r = (payload && payload.new) || {};
      if (r.status !== 'pending') return;
      var forMe = r.dispatch_mode === 'open' || r.target_driver_id === profile.driver_id;
      if (!forMe) return;
      showToast('New delivery request available');
      if (typeof onNew === 'function') onNew();
    }
  );
}

// Outlets: toast when one of their own deliveries is completed.
// onCompleted() (optional) refreshes the history / active lists.
function initOutletNotifications(profile, onCompleted) {
  if (!profile || !profile.outlet_id) return null;
  return fleetSubscribe(
    'outlet-completions-' + profile.outlet_id,
    {
      event: 'UPDATE',
      schema: 'public',
      table: 'vehicle_requests',
      filter: 'outlet_id=eq.' + profile.outlet_id,
    },
    function (payload) {
      var r = (payload && payload.new) || {};
      if (r.status !== 'completed') return;
      showToast('Your delivery has been completed');
      if (typeof onCompleted === 'function') onCompleted();
    }
  );
}

// Wires an optional "Enable alerts" button. Shown only when the browser
// supports notifications and the user hasn't decided yet; hidden once
// they grant or deny.
function initAlertsButton(btnId) {
  var btn = document.getElementById(btnId);
  if (!btn) return;
  if (!window.Notification || Notification.permission !== 'default') {
    btn.classList.add('hidden');
    return;
  }
  btn.addEventListener('click', function () {
    requestNotifyPermission(function (state) {
      btn.classList.add('hidden');
      if (state === 'granted') showToast('Alerts enabled');
    });
  });
}
