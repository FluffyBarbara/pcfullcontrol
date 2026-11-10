'use strict';
// Разное: ссылки, запуск программ, сообщение на экран, озвучка, буфер обмена, терминал, корзина.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IS_WIN, IS_MAC, run, powershell, spawnDetached, psQuote, CMD_EXE } = require('./exec');

const electron = () => require('electron');

async function openUrl(arg) {
  let url = String(arg || '').trim();
  if (!url) throw new Error('Укажите ссылку');
  if (!url.includes('://')) url = 'https://' + url;
  if (!/^https?:\/\//i.test(url)) throw new Error('Поддерживаются только ссылки http/https');
  await electron().shell.openExternal(url);
  return `Открываю ${url}`;
}

async function launch(arg, { source = 'app', files = null, apps = [] } = {}) {
  const target = String(arg || '').trim().replace(/^"(.*)"$/, '$1');
  if (!target) throw new Error('Укажите программу или путь');
  if (/^https?:\/\//i.test(target)) return openUrl(target);
  // Программы из списка «Мои программы» владелец добавил сам — их можно запускать откуда угодно
  const own = (apps || []).some((a) => a && String(a.cmd || '').trim().replace(/^"(.*)"$/, '$1') === target);
  const remote = source !== 'app' && source !== 'local';
  if (fs.existsSync(target) && remote && !own && files) {
    // С телефона или из Telegram — по тем же правилам, что и файлы: по умолчанию только ваша папка
    // пользователя (без AppData), данные программы — никогда; системные программы — только по имени
    files.check(target, 'exec');
  }
  if (fs.existsSync(target)) {
    const err = await electron().shell.openPath(target);
    if (err) throw new Error(err);
  } else if (!/^[\p{L}\p{N} ._+-]{1,100}$/u.test(target)) {
    // Только имя программы: символы & | < > ^ " % позволили бы выполнить любую команду в обход запрета
    throw new Error('Укажите имя программы (например, notepad) или путь к файлу. Для команд включите «Выполнение команд» в настройках.');
  } else if (IS_WIN) {
    // Имя программы (notepad, chrome) — через start, как в окне «Выполнить»
    spawnDetached(CMD_EXE, ['/d', '/s', '/c', `start "" ${target}`], { windowsVerbatimArguments: true });
  } else if (IS_MAC) {
    spawnDetached('open', ['-a', target]);
  } else {
    spawnDetached('/bin/sh', ['-c', target]);
  }
  return `Запущено: ${target}`;
}

/** Окно с сообщением поверх всех окон. */
async function showMessage(arg) {
  const text = String(arg || '').trim();
  if (!text) throw new Error('Укажите текст сообщения');
  const { BrowserWindow } = electron();
  const win = new BrowserWindow({
    width: 460, height: 240, alwaysOnTop: true, frame: false, resizable: false, skipTaskbar: false,
    show: false, backgroundColor: '#191d24', title: 'Сообщение с телефона',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  await win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'message.html'), { query: { text } });
  win.show();
  win.focus();
  win.flashFrame(true);
  return 'Сообщение показано на экране 💬';
}

async function say(arg) {
  const text = String(arg || '').trim();
  if (!text) throw new Error('Укажите текст для озвучки');
  if (IS_WIN) {
    powershell(`Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak(${psQuote(text)})`, 180e3);
  } else if (IS_MAC) {
    spawnDetached('say', [text]);
  } else {
    spawnDetached('spd-say', ['-l', 'ru', text]);
  }
  return 'Озвучиваю 🗣';
}

async function clipboardGet() {
  // В новых версиях Electron методы буфера обмена могут быть асинхронными
  const t = String((await electron().clipboard.readText()) ?? '');
  return t.trim() ? t : '(буфер обмена пуст)';
}

async function clipboardSet(arg) {
  await electron().clipboard.writeText(String(arg || ''));
  return 'Текст скопирован в буфер обмена ПК 📋';
}

async function shellCommand(arg) {
  const cmd = String(arg || '').trim();
  if (!cmd) throw new Error('Укажите команду');
  const r = IS_WIN ? await powershell(cmd, 120e3) : await run('/bin/sh', ['-c', cmd], { timeout: 120e3 });
  return `PS> ${cmd}\n${r.out || '(нет вывода)'}\n[код выхода: ${r.code}]`;
}

async function emptyRecycleBin() {
  if (IS_WIN) await powershell('Clear-RecycleBin -Force -ErrorAction SilentlyContinue', 120e3);
  else if (IS_MAC) await run('osascript', ['-e', 'tell application "Finder" to empty trash']);
  else {
    const trash = path.join(os.homedir(), '.local/share/Trash');
    for (const sub of ['files', 'info']) fs.rmSync(path.join(trash, sub), { recursive: true, force: true });
  }
  return 'Корзина очищена 🗑';
}

module.exports = { openUrl, launch, showMessage, say, clipboardGet, clipboardSet, shellCommand, emptyRecycleBin };
