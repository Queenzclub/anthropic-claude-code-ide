// Registers the service worker (installable app + offline shell) and
// shows a friendly notice when the connection drops or comes back.
// Registration is best-effort: the app works identically without it.
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {
        // No service worker (e.g. unsupported or blocked) — app still works.
      });
    });
  }

  function notify(message, type) {
    if (typeof showFlash === 'function' && document.getElementById('flash')) {
      showFlash(message, type);
    }
  }

  window.addEventListener('offline', function () {
    notify('You are offline. Changes cannot be saved until you reconnect.', 'error');
  });

  window.addEventListener('online', function () {
    notify('You are back online.', 'success');
  });
})();
