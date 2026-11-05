'use strict';
// Снимок с веб-камеры: включаем камеру, ждём настройки экспозиции, берём кадр.
(async () => {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
    const v = document.getElementById('v');
    v.srcObject = stream;
    await v.play();
    await new Promise((r) => setTimeout(r, 1500));
    const c = document.getElementById('c');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    window.capture.done(c.toDataURL('image/jpeg', 0.88));
  } catch (e) {
    window.capture.fail(e.name === 'NotFoundError' ? 'Веб-камера не найдена' : `Камера недоступна: ${e.message || e.name}`);
  } finally {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }
})();
