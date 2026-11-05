'use strict';
document.getElementById('text').textContent = new URLSearchParams(location.search).get('text') || '';
document.getElementById('ok').addEventListener('click', () => window.close());
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') window.close(); });
