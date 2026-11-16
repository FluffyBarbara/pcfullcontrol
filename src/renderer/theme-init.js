// Тема и цвет акцента — до отрисовки окна, чтобы не мигало (значения запоминаются из настроек).
(function () {
  try {
    const t = localStorage.getItem('pcfc-theme') || 'dark';
    const a = localStorage.getItem('pcfc-accent') || 'indigo';
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = t === 'system' ? (dark ? 'dark' : 'light') : t;
    document.documentElement.dataset.accent = a;
  } catch (e) { /* по умолчанию — тёмная */ }
  // Слабый компьютер (до 4 потоков процессора или до 4 ГБ памяти) — облегчённый режим: без анимаций и размытия
  try {
    const cores = navigator.hardwareConcurrency || 8;
    const mem = navigator.deviceMemory || 8;
    const forced = localStorage.getItem('pcfc-lite');
    const lite = forced === '1' || (forced !== '0' && (cores <= 4 || mem <= 4));
    if (lite) document.documentElement.classList.add('lite');
  } catch (e) { /* обычный режим */ }
})();
