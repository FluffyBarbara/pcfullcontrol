'use strict';
// Голосовые команды: распознанный текст («выключи компьютер через полчаса») → действие программы.

const UNITS = {
  ноль: 0, один: 1, одна: 1, одну: 1, одного: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9,
  десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16,
  семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
};
const TENS = { двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100 };

function normalize(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/\.(?=\s|$)/g, ' ').replace(/[«»"“”„,!?;:()…]/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Число цифрами или словами в начале строки: «25», «двадцать пять» → { value, rest }. */
function readNumber(s) {
  const m = /^(\d+(?:[.,]\d+)?)\s*/.exec(s);
  if (m) return { value: parseFloat(m[1].replace(',', '.')), rest: s.slice(m[0].length) };
  const words = s.split(' ');
  let value = null;
  let used = 0;
  if (TENS[words[0]] !== undefined) {
    value = TENS[words[0]];
    used = 1;
    if (UNITS[words[1]] !== undefined && UNITS[words[1]] < 10) { value += UNITS[words[1]]; used = 2; }
  } else if (UNITS[words[0]] !== undefined) {
    value = UNITS[words[0]];
    used = 1;
  }
  return value === null ? null : { value, rest: words.slice(used).join(' ') };
}

/** «через полчаса», «через 2 часа 30 минут», «через пять минут» → минуты. */
function parseDelay(t) {
  if (/через пол ?часа/.test(t)) return 30;
  if (/через полтора часа/.test(t)) return 90;
  const m = /через\s+(.+)$/.exec(t);
  if (!m) return null;
  let rest = m[1];
  if (/^час(а|ов)?(?=\s|$)/.test(rest)) return 60 + (parseDelay('через ' + rest.replace(/^час(а|ов)?\s*/, '')) || 0);
  if (/^минуту(?=\s|$)/.test(rest)) return 1;
  let total = 0;
  let found = false;
  for (let i = 0; i < 3; i++) {
    const n = readNumber(rest);
    if (!n) break;
    const u = /^(секунд\S*|сек\S*|минут\S*|мин\S*|час\S*|ч(?=\s|$))\s*(и\s+)?/.exec(n.rest);
    if (!u) break;
    found = true;
    total += /^с/.test(u[1]) ? n.value / 60 : /^ч/.test(u[1]) ? n.value * 60 : n.value;
    rest = n.rest.slice(u[0].length);
  }
  return found ? Math.max(1, Math.round(total)) : null;
}

const SITES = {
  ютуб: 'https://youtube.com', youtube: 'https://youtube.com', вк: 'https://vk.com', вконтакте: 'https://vk.com', гугл: 'https://google.com',
  яндекс: 'https://ya.ru', твич: 'https://twitch.tv', почту: 'https://mail.google.com', почта: 'https://mail.google.com', кинопоиск: 'https://kinopoisk.ru',
};
const PROGRAMS = {
  стим: 'steam', steam: 'steam', телеграм: 'telegram', телеграмм: 'telegram', дискорд: 'discord', хром: 'chrome', 'гугл хром': 'chrome',
  браузер: 'msedge', эдж: 'msedge', блокнот: 'notepad', калькулятор: 'calc', проводник: 'explorer', 'диспетчер задач': 'taskmgr',
  ворд: 'winword', эксель: 'excel', спотифай: 'spotify', обс: 'obs64', paint: 'mspaint', пэинт: 'mspaint', 'панель управления': 'control',
  настройки: 'ms-settings:', терминал: 'wt', 'командную строку': 'cmd', фотошоп: 'photoshop', vlc: 'vlc',
};

/**
 * Разбор голосовой команды.
 * @param {string} text распознанная речь
 * @param {{ apps?: {name:string, cmd:string}[] }} opts кнопки быстрого запуска из настроек
 * @returns {{ action: string, arg?: string, minutes?: number, text?: string, title: string } | null}
 */
function parseVoiceCommand(text, { apps = [] } = {}) {
  const t = normalize(text);
  if (!t) return null;
  const delay = parseDelay(t);
  const withDelay = (title) => (delay ? `${title} через ${delay} мин` : title);
  const has = (re) => re.test(t);

  // Напоминание: «напомни через 10 минут выключить чайник», «напомни купить хлеб через час»
  let m = /напомни(?:ть)?(?: мне)?(?: о том)?(?: что)?\s+(.*)$/.exec(t);
  if (m) {
    const minutes = delay || 60;
    const what = m[1].replace(/через\s+(пол ?часа|полтора часа|час(а|ов)?|[\wа-я]+(\s+[\wа-я]+)?\s+(секунд\S*|минут\S*|мин\S*|час\S*))(\s+\d+\s+минут\S*)?/, '').trim() || 'напоминание';
    return { action: 'remind', minutes, text: what, title: `Напомнить «${what}» через ${minutes} мин` };
  }
  if (has(/отмен\S* (выключени|перезагрузк)|не выключай/)) return { action: 'cancel_shutdown', title: 'Отменить выключение' };
  if (has(/отчет за неделю|недельн\S* отчет|итоги недели/)) return { action: 'weekly_report', title: 'Отчёт за неделю' };
  if (has(/скорост\S* интернет|спидтест|speed ?test|замер\S* скорост/)) return { action: 'speedtest', title: 'Замерить скорость интернета' };
  if (has(/что (сейчас )?(играет|за (песня|трек|музыка))|как\S* (это )?(песня|музыка|композиция|трек)|кто (сейчас )?поет/)) return { action: 'now_playing', title: 'Что сейчас играет' };
  if (has(/тревог|тревожн|паник/)) return { action: 'panic', title: 'Тревожная кнопка' };
  if (has(/видеокарт|температур\S* (видео|gpu)|фпс|fps/)) return { action: 'gpu', title: 'Состояние видеокарты' };
  if (has(/температур|насколько (греется|горяч)|перегрев/)) return { action: 'temps', title: 'Температуры' };
  if (has(/перезагру|перезапусти (компьютер|пк|комп)|ребут/)) return { action: 'reboot', arg: delay ? String(delay) : '', title: withDelay('Перезагрузить ПК') };
  if (has(/(выключи|погаси|отключи)\S* (монитор|экран|дисплей)/)) return { action: 'monitor_off', title: 'Выключить монитор' };
  if (has(/(выключи|отключи|убери|вырубить|выруби)\S* звук|без звука|включи звук|звук (выключи|включи)|беззвучн/)) return { action: 'mute', title: 'Выключить/включить звук' };
  m = /громкост\S*(?: на)?\s+(.+)$|(?:звук|громкость) на\s+(.+)$/.exec(t);
  if (m) {
    const s = (m[1] || m[2] || '').trim();
    let v = null;
    if (/максим|полн|сто проц/.test(s)) v = 100;
    else if (/миним|ноль/.test(s)) v = 0;
    else if (/половин|пол/.test(s)) v = 50;
    else { const n = readNumber(s); if (n) v = n.value; }
    if (v !== null) { v = Math.max(0, Math.min(100, Math.round(v))); return { action: 'set_volume', arg: String(v), title: `Громкость ${v}%` }; }
  }
  if (has(/громче|прибав\S*|погромче|увелич\S* (звук|громк)/)) return { action: 'volume_up', title: 'Громче' };
  if (has(/тише|убав\S*|потише|уменьш\S* (звук|громк)/)) return { action: 'volume_down', title: 'Тише' };
  if (has(/(выключи|выключить|вырубай|выруби|отключи|заверши)\S*(\s+(работу|компьютер|пк|комп|компьютер))?$|выключи (компьютер|пк|комп)|выключение (компьютера|пк)|выключи через|выключайся/)) {
    return { action: 'shutdown', arg: delay ? String(delay) : '', title: withDelay('Выключить ПК') };
  }
  if (has(/гибернац/)) return { action: 'hibernate', title: 'Гибернация' };
  if (has(/спящ\S* режим|в сон|усыпи|спать|засыпай/)) return { action: 'sleep', title: 'Спящий режим' };
  if (has(/заблокир|блокировк|запри/)) return { action: 'lock', title: 'Заблокировать экран' };
  if (has(/выйди из (системы|учетной|аккаунта)|выход из системы|разлогин/)) return { action: 'logoff', title: 'Выйти из системы' };
  if (has(/скриншот|скрин(?=\s|$)|снимок экрана|сфотографируй экран|что на экране/)) return { action: 'screenshot', title: 'Скриншот' };
  if (has(/веб ?камер|вебк|с камеры|сфотографируй|кто (сидит )?за (компьютером|компом)/)) return { action: 'webcam', title: 'Фото с веб-камеры' };
  if (has(/следующ\S* (трек|песн|композици|видео)|переключи (трек|песню)|дальше/)) return { action: 'next_track', title: 'Следующий трек' };
  if (has(/предыдущ\S* (трек|песн|композици)|прошл\S* (трек|песн)/)) return { action: 'prev_track', title: 'Предыдущий трек' };
  if (has(/пауз|продолж\S* (воспроизвед|музык|видео)|воспроизвед|включи музыку|останови музыку|^стоп$/)) return { action: 'play_pause', title: 'Пауза/воспроизведение' };
  if (has(/проверь обновлени/)) return { action: 'check_updates', title: 'Проверить обновления программ' };
  if (has(/обнови (все )?(программы|приложения)/)) return { action: 'upgrade_all', title: 'Обновить все программы' };
  if (has(/обнови (виндовс|windows|систему)/)) return { action: 'win_update_install', title: 'Установить обновления Windows' };
  if (has(/очисти\S* корзин/)) return { action: 'empty_recycle_bin', title: 'Очистить корзину' };
  if (has(/^(статус|состояние|отчет)|как (там )?(компьютер|комп|дела)|нагрузк/)) return { action: 'status_report', title: 'Отчёт о состоянии' };
  m = /^(?:скажи|произнеси|озвучь)\s+(.+)$/.exec(t);
  if (m) return { action: 'say', arg: m[1], title: `Озвучить «${m[1]}»` };
  m = /^(?:напиши|покажи|выведи)(?: сообщение)?(?: на экран\S*)?\s+(.+)$/.exec(t);
  if (m) return { action: 'message', arg: m[1], title: `Сообщение на экран «${m[1]}»` };

  // Открыть сайт / запустить программу
  m = /^(?:открой|запусти|включи|зайди на|открыть|запустить)(?: сайт| программу| приложение)?\s+(.+)$/.exec(t);
  if (m) {
    const what = m[1].trim();
    const site = SITES[what] || (/^[\w.-]+\.(ru|com|net|org|tv|io|рф)$/.test(what.replace(/ точка /g, '.')) ? 'https://' + what.replace(/ точка /g, '.') : null);
    if (site) return { action: 'open_url', arg: site, title: `Открыть ${site}` };
    const own = apps.find((a) => normalize(a.name) === what) || apps.find((a) => normalize(a.name).includes(what) || what.includes(normalize(a.name)));
    if (own) return { action: 'launch', arg: own.cmd, title: `Запустить ${own.name}` };
    const prog = PROGRAMS[what];
    if (prog) return { action: 'launch', arg: prog, title: `Запустить ${what}` };
    return { action: 'launch', arg: what, title: `Запустить ${what}` };
  }
  return null;
}

const EXAMPLES = [
  '«Выключи компьютер через полчаса»', '«Громкость 30»', '«Заблокируй компьютер»', '«Сделай скриншот»',
  '«Запусти Steam»', '«Открой YouTube»', '«Напомни выключить духовку через 20 минут»', '«Поставь на паузу»',
  '«Отмени выключение»', '«Скорость интернета»', '«Видеокарта»', '«Отчёт за неделю»', '«Что сейчас играет?»', '«Температура»',
];

module.exports = { parseVoiceCommand, parseDelay, normalize, readNumber, EXAMPLES };
