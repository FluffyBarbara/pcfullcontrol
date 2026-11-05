'use strict';
// Проверка на настоящей Windows: экран ПК через интернет (туннель Cloudflare) — поток H.264 по WebSocket,
// декодирование в браузере (WebCodecs) и управление курсором по тому же соединению.
// Запуск: node scripts/e2e-ws.js <путь к playwright-core> <одноразовая ссылка для входа>
const pw = require(process.argv[2]);
const link = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await pw.chromium.launch({ channel: 'chrome', headless: false, args: ['--window-position=0,0', '--window-size=900,700'] });
  const page = await browser.newPage({ viewport: { width: 860, height: 560 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(link);
  await page.waitForSelector('.gauge', { timeout: 60000 });
  console.log('Вход через интернет выполнен:', page.url().split('#')[0]);
  await page.evaluate(() => {
    const d = document.createElement('div');
    Object.assign(d.style, { position: 'fixed', left: '20px', top: '20px', width: '160px', height: '160px', background: 'linear-gradient(135deg,#f0f,#0ff)', zIndex: 100 });
    document.body.append(d);
    const tick = (t) => { d.style.transform = `translateX(${(Math.sin(t / 300) + 1) * 250}px) rotate(${t / 5}deg)`; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.RemoteControl.open({ force: 'ws' });
  });
  const state = () => page.evaluate(() => window.RemoteControl.state());
  let st;
  for (let i = 0; i < 40; i++) { await sleep(500); st = await state(); if (st.transport === 'ws' && st.frames > 0) break; }
  if (!st || st.transport !== 'ws' || !st.frames) throw new Error('Поток через интернет не пошёл: ' + JSON.stringify(st));
  let best = 0;
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    const s = await state();
    best = Math.max(best, s.view.fps || 0);
    console.log(`Через интернет: телефон ${s.view.fps} к/с ${s.view.w}x${s.view.h}, задержка ${s.view.ping} мс, ПК кодирует ${s.host.fps} к/с, ${s.host.kbps} кбит/с, ${s.host.codec}${s.host.hw ? ' (видеокарта)' : ''}`);
  }
  if (best < 8) throw new Error('Слишком мало кадров через интернет: ' + best);
  await page.evaluate(() => window.RemoteControl.send({ type: 'move', x: 0.3, y: 0.6 }));
  await sleep(1500);
  const c = (await state()).cursor;
  console.log('Курсор после move 0.3,0.6 через интернет:', JSON.stringify(c));
  if (!c || Math.abs(c[0] - 0.3) > 0.03 || Math.abs(c[1] - 0.6) > 0.03) throw new Error('Курсор не управляется через интернет');
  await page.evaluate(() => window.RemoteControl.close());
  if (errors.length) throw new Error('Ошибки на странице: ' + errors.join('; '));
  await browser.close();
  console.log('Экран через интернет: поток H.264 и управление работают');
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
