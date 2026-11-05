'use strict';
// Проверка на настоящей Windows: телефонное приложение (в Chrome) получает экран ПК видео по WebRTC,
// переключает качество на 120 кадр/с и двигает курсор через канал данных.
// Запуск: node scripts/e2e-rtc.js <путь к playwright-core> <токен телефона>
const pw = require(process.argv[2]);
const token = process.argv[3];
const URL = 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await pw.chromium.launch({
    channel: 'chrome', headless: false,
    args: ['--autoplay-policy=no-user-gesture-required', '--window-position=0,0', '--window-size=900,700'],
  });
  const page = await browser.newPage({ viewport: { width: 860, height: 560 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.evaluate((t) => localStorage.setItem('pcfc_token', t), token);
  await page.goto(URL);
  await page.waitForSelector('.gauge', { timeout: 30000 });
  // Движение на экране, чтобы было что передавать (страница сама видна на рабочем столе ПК)
  await page.evaluate(() => {
    const d = document.createElement('div');
    Object.assign(d.style, { position: 'fixed', left: '20px', top: '20px', width: '160px', height: '160px', background: 'linear-gradient(135deg,#f0f,#0ff)', zIndex: 100 });
    document.body.append(d);
    const tick = (t) => { d.style.transform = `translateX(${(Math.sin(t / 300) + 1) * 250}px) rotate(${t / 5}deg)`; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.RemoteControl.open();
  });
  const state = () => page.evaluate(() => window.RemoteControl.state());
  let st = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    st = await state();
    if (st.transport && st.view && st.view.fps > 0) break;
  }
  if (!st || st.transport !== 'rtc') throw new Error('Видео по WebRTC не подключилось: ' + JSON.stringify(st));

  const sample = async (label, secs) => {
    let best = null;
    for (let i = 0; i < secs; i++) {
      await sleep(1000);
      const s = await state();
      console.log(`${label}: телефон ${s.view.fps} к/с ${s.view.w}x${s.view.h}, ПК кодирует ${s.host.fps} к/с из ${s.host.target}, ${s.host.codec} (${s.host.encoder}${s.host.hw ? ', аппаратно' : ''}), ${s.host.kbps} кбит/с, ограничение: ${s.host.limit}`);
      if (!best || s.view.fps > best.view.fps) best = s;
    }
    return best;
  };
  const auto = await sample('Авто', 6);
  if (auto.view.fps < 10) throw new Error('Слишком мало кадров в секунду: ' + auto.view.fps);

  await page.evaluate(() => window.RemoteControl.setPreset('smooth'));
  const smooth = await sample('Плавность 120', 6);
  if (smooth.host.target !== 120) throw new Error('Режим 120 кадр/с не включился');

  // Курсор через канал данных WebRTC: абсолютное и относительное перемещение
  await page.evaluate(() => window.RemoteControl.send({ type: 'move', x: 0.75, y: 0.25 }));
  await sleep(1500);
  const c1 = (await state()).cursor;
  console.log('Курсор после move 0.75,0.25:', JSON.stringify(c1));
  if (!c1 || Math.abs(c1[0] - 0.75) > 0.03 || Math.abs(c1[1] - 0.25) > 0.03) throw new Error('Курсор не переместился по каналу WebRTC');
  await page.evaluate(() => window.RemoteControl.send({ type: 'rel', dx: -200, dy: 100 }));
  await sleep(1500);
  const c2 = (await state()).cursor;
  console.log('Курсор после сдвига -200,+100:', JSON.stringify(c2));
  if (!c2 || !(c2[0] < c1[0] - 0.05) || !(c2[1] > c1[1] + 0.05)) throw new Error('Относительное перемещение (тачпад) не сработало');

  await page.evaluate(() => window.RemoteControl.close());
  await sleep(500);
  if (errors.length) throw new Error('Ошибки на странице: ' + errors.join('; '));
  await browser.close();
  console.log('WebRTC: видео, режим 120 кадр/с и управление курсором работают');
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(1); });
