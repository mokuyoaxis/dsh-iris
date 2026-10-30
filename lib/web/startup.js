// Render-blocking and dependency-free: restore only the saved colour mode before the first paint.
(() => {
  const root = document.documentElement;
  let theme = 'light';
  try {
    const saved = JSON.parse(localStorage.getItem('iris.panel.appearance.v0'));
    if (saved?.contractVersion === 0 && ['light', 'dark', 'system'].includes(saved.theme)) theme = saved.theme;
  } catch (error) {
    if (!['SyntaxError', 'SecurityError', 'QuotaExceededError', 'InvalidStateError'].includes(error.name)) throw error;
  }
  root.dataset.theme = theme === 'dark' || theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  // A failed entry module/stylesheet must leave a useful screen, rather than an endless loading message.
  window.addEventListener('error', event => {
    if (root.dataset.startup !== 'pending') return;
    if (event instanceof ErrorEvent || event.target instanceof HTMLScriptElement
        || event.target instanceof HTMLLinkElement && event.target.rel === 'stylesheet') root.dataset.startup = 'failed';
  }, true);
})();
