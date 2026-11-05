'use strict';
// История версий. Показывается в окне «Что нового» после обновления, в Telegram и в описании релиза.
(function (root) {
  const CHANGELOG = [
    {
      version: '1.1.0',
      date: '2026-11-05',
      title: 'Приложение для телефона и новый дизайн',
      items: [
        ['phone', 'Приложение для телефона: Android (APK) и iPhone (через Safari → «На экран Домой»). Работает по Wi-Fi.'],
        ['qr', 'Привязка телефона по QR-коду или 6-значному коду — без паролей.'],
        ['sparkles', 'Полностью новый дизайн программы на ПК: свой заголовок окна, кольцевые индикаторы, графики, иконки.'],
        ['activity', 'Новый раздел «Процессы» в программе на ПК — поиск и завершение программ.'],
        ['upload', 'С телефона можно загружать файлы на ПК, скачивать их и отправлять в Telegram.'],
        ['update', 'Установка обновлений прямо из окна программы и окно «Что нового» после обновления.'],
        ['shield', 'Список привязанных телефонов с возможностью отвязать любой из них.'],
      ],
    },
    {
      version: '1.0.0',
      date: '2026-11-05',
      title: 'Первая версия',
      items: [
        ['telegram', 'Управление компьютером через Telegram-бота: питание, звук, скриншоты, файлы, процессы.'],
        ['update', 'Обновление программ (winget, Chocolatey, Scoop) и Windows Update.'],
        ['bell', 'Уведомления: ПК включён, перегрев, мало места, вход в систему и другое.'],
        ['calendar', 'Планировщик задач: «выключи в 23:30», «по будням в 8:00».'],
      ],
    },
  ];

  function cmp(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
    return 0;
  }

  /** Версии новее `from` и не новее `to`. */
  function between(from, to) {
    return CHANGELOG.filter((v) => (!from || cmp(v.version, from) > 0) && cmp(v.version, to) <= 0);
  }

  const api = { CHANGELOG, between, cmp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Changelog = api;
})(typeof window !== 'undefined' ? window : globalThis);
