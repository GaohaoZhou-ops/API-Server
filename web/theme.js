// Apply the saved palette before styles and content paint, independently of login.
(() => {
  const key = 'api-docs-theme', root = document.documentElement;
  let current = 'light';
  function apply(value) {
    current = value === 'dark' ? 'dark' : 'light';
    root.dataset.theme = current;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', current);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', current === 'dark' ? '#101a14' : '#ffffff');
    const button = document.getElementById('theme-toggle');
    if (button) {
      const label = current === 'dark' ? '切换到浅色主题' : '切换到深色主题';
      button.setAttribute('aria-label', label); button.title = label;
      button.setAttribute('aria-pressed', String(current === 'dark')); button.disabled = false;
    }
  }
  try { current = localStorage.getItem(key) === 'dark' ? 'dark' : 'light'; } catch {}
  apply(current);
  document.addEventListener('DOMContentLoaded', () => {
    apply(current);
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      apply(current === 'dark' ? 'light' : 'dark');
      try { localStorage.setItem(key, current); } catch {}
    });
  }, {once: true});
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) apply(event.newValue);
  });
})();
