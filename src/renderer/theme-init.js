// Тема и цвет акцента — до отрисовки окна, чтобы не мигало (значения запоминаются из настроек).
(function () {
  try {
    const t = localStorage.getItem('pcfc-theme') || 'dark';
    const a = localStorage.getItem('pcfc-accent') || 'indigo';
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = t === 'system' ? (dark ? 'dark' : 'light') : t;
    document.documentElement.dataset.accent = a;
  } catch (e) { /* по умолчанию — тёмная */ }
})();
