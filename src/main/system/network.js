'use strict';
// Интернет и домашняя сеть: проверка связи (обрывы), замер скорости, список устройств в сети.
const dgram = require('dgram');
const dns = require('dns');
const os = require('os');
const crypto = require('crypto');
const si = require('systeminformation');
const { IS_WIN, run } = require('./exec');

const CHECK_URLS = ['http://www.msftconnecttest.com/connecttest.txt', 'http://connectivitycheck.gstatic.com/generate_204', 'https://1.1.1.1/cdn-cgi/trace'];

async function timedFetch(url, opts = {}, ms = 6000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal, cache: 'no-store' });
  } finally { clearTimeout(t); }
}

/** Есть ли интернет: хотя бы один из адресов отвечает. Возвращает { online, ms }. */
async function checkInternet() {
  for (const url of CHECK_URLS) {
    const t0 = Date.now();
    try {
      const r = await timedFetch(url, { method: 'GET' }, 5000);
      await r.arrayBuffer().catch(() => {});
      if (r.status < 500) return { online: true, ms: Date.now() - t0 };
    } catch (e) { /* следующий адрес */ }
  }
  return { online: false, ms: null };
}

/**
 * Замер скорости через серверы Cloudflare: задержка, скачивание и загрузка (Мбит/с).
 * Расходует примерно 60–150 МБ трафика.
 */
async function speedTest({ onProgress = () => {} } = {}) {
  const base = 'https://speed.cloudflare.com';
  // Задержка: минимум из нескольких маленьких запросов
  const pings = [];
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now();
    try { const r = await timedFetch(`${base}/__down?bytes=0`, {}, 5000); await r.arrayBuffer(); pings.push(performance.now() - t0); } catch (e) { /* пропуск */ }
  }
  if (!pings.length) throw new Error('Нет связи с сервером замера скорости');
  pings.sort((a, b) => a - b);
  const ping = Math.round(pings[0]);
  const jitter = Math.round(pings.length > 1 ? pings.slice(1).reduce((s, p, i) => s + Math.abs(p - pings[i]), 0) / (pings.length - 1) : 0);
  onProgress({ stage: 'down', ping });

  // Скачивание: 4 потока в течение ~8 секунд
  const downBytes = await measure(8000, 4, async (stop, add) => {
    while (!stop()) {
      const r = await timedFetch(`${base}/__down?bytes=25000000`, {}, 15000);
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        add(value.length);
        if (stop()) { reader.cancel().catch(() => {}); break; }
      }
    }
  });
  const down = +(downBytes.bits / downBytes.sec / 1e6).toFixed(1);
  onProgress({ stage: 'up', ping, down });

  // Загрузка: 3 потока по 8 МБ в течение ~7 секунд
  const chunk = crypto.randomBytes(8 * 1024 * 1024);
  const upBytes = await measure(7000, 3, async (stop, add) => {
    while (!stop()) {
      const r = await timedFetch(`${base}/__up`, { method: 'POST', body: chunk, headers: { 'Content-Type': 'application/octet-stream' } }, 20000);
      await r.arrayBuffer().catch(() => {});
      add(chunk.length);
    }
  });
  const up = +(upBytes.bits / upBytes.sec / 1e6).toFixed(1);
  return { ts: Date.now() / 1000, ping, jitter, down, up };
}

async function measure(ms, streams, worker) {
  let bytes = 0;
  const t0 = performance.now();
  const stop = () => performance.now() - t0 > ms;
  await Promise.all(Array.from({ length: streams }, () => worker(stop, (n) => { bytes += n; }).catch(() => {})));
  const sec = Math.max(0.5, (performance.now() - t0) / 1000);
  return { bits: bytes * 8, sec };
}

// ---------------- устройства в домашней сети ----------------
function ipToInt(ip) { return ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0; }
function intToIp(n) { return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.'); }

/** Адреса подсети (не больше 1024), без адреса сети и широковещательного. */
function subnetHosts(ip, netmask) {
  const ipn = ipToInt(ip);
  let mask = ipToInt(netmask);
  const size = (~mask >>> 0) + 1;
  if (size > 1024) mask = ipToInt('255.255.252.0');
  const net = ipn & mask;
  const bc = (net | (~mask >>> 0)) >>> 0;
  const out = [];
  for (let n = net + 1; n < bc; n++) out.push(intToIp(n >>> 0));
  return out;
}

/** Таблица ARP (IP → MAC) из `arp -a` (Windows) или `ip neigh` (Linux). */
function parseArp(text) {
  const res = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /(\d{1,3}(?:\.\d{1,3}){3})\D+?([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})/i.exec(line);
    if (!m) continue;
    const mac = m[2].toUpperCase().replace(/-/g, ':');
    if (/^(FF:FF:FF:FF:FF:FF|00:00:00:00:00:00)$/.test(mac) || /^01:00:5E/.test(mac) || /^33:33/.test(mac)) continue;
    const last = Number(m[1].split('.')[3]);
    if (last === 255 || Number(m[1].split('.')[0]) >= 224) continue;
    if (/FAILED|INCOMPLETE/i.test(line)) continue;
    res.push({ ip: m[1], mac });
  }
  return res;
}

/** MAC с «локальным» битом — случайный адрес, так прячутся телефоны и планшеты. */
const isRandomMac = (mac) => /^.[26AE]/i.test(mac);

const OUI = {
  '00:1A:11': 'Google', 'F4:F5:D8': 'Google', '3C:5A:B4': 'Google', 'D8:EB:46': 'Google',
  'F0:18:98': 'Apple', 'AC:BC:32': 'Apple', '3C:22:FB': 'Apple', 'A4:83:E7': 'Apple', '28:CF:E9': 'Apple', 'BC:D0:74': 'Apple', '8C:85:90': 'Apple',
  '50:EC:50': 'Xiaomi', '64:09:80': 'Xiaomi', '78:11:DC': 'Xiaomi', '28:6C:07': 'Xiaomi', '7C:49:EB': 'Xiaomi', '04:CF:8C': 'Xiaomi',
  '8C:79:F5': 'Samsung', 'F8:04:2E': 'Samsung', '5C:49:7D': 'Samsung', 'CC:07:AB': 'Samsung', '24:4B:81': 'Samsung',
  '50:C7:BF': 'TP-Link', '98:DA:C4': 'TP-Link', 'C0:06:C3': 'TP-Link', '60:32:B1': 'TP-Link', 'B0:BE:76': 'TP-Link', '14:EB:B6': 'TP-Link',
  '04:D4:C4': 'ASUS', '2C:FD:A1': 'ASUS', '1C:87:2C': 'ASUS', '00:E0:4C': 'Realtek', '00:0C:29': 'VMware', '08:00:27': 'VirtualBox',
  '48:8F:5A': 'Routerboard (MikroTik)', 'CC:2D:E0': 'MikroTik', '74:4D:28': 'MikroTik', '00:1D:0F': 'TP-Link',
  'E4:5F:01': 'Raspberry Pi', 'DC:A6:32': 'Raspberry Pi', 'B8:27:EB': 'Raspberry Pi',
  '44:65:0D': 'Amazon', 'FC:A6:67': 'Amazon', '68:54:FD': 'Amazon', '00:17:88': 'Philips Hue',
  '7C:2E:BD': 'Google', '00:24:D4': 'Free', 'AC:84:C6': 'TP-Link', '80:2A:A8': 'Ubiquiti', 'FC:EC:DA': 'Ubiquiti',
  'E8:9F:80': 'Belkin', '00:11:32': 'Synology', '00:90:A9': 'WD', '30:B5:C2': 'TP-Link', '00:26:5A': 'D-Link', '1C:7E:E5': 'D-Link',
  '00:1E:58': 'D-Link', 'C8:3A:35': 'Tenda', 'B4:0F:3B': 'Tenda', '00:18:E7': 'Cameo', '88:D7:F6': 'ASUS', '18:31:BF': 'ASUS',
  '9C:5C:8E': 'ASUS', '00:25:9C': 'Cisco-Linksys', '58:EF:68': 'Belkin', 'A0:63:91': 'Netgear', '20:E5:2A': 'Netgear', '00:1F:33': 'Netgear',
  '34:CE:00': 'Xiaomi', '9C:9D:7E': 'Xiaomi', 'A8:6B:AD': 'Huawei', '00:E0:FC': 'Huawei', '48:46:FB': 'Huawei', 'E8:CD:2D': 'Huawei',
  '70:8A:09': 'Huawei', 'CC:B0:DA': 'Huawei', '00:9A:CD': 'Huawei', 'F4:8B:32': 'Xiaomi', '6C:5A:B0': 'TP-Link', '54:AF:97': 'TP-Link',
  'B8:D7:AF': 'Murata (Samsung)', '00:50:56': 'VMware', '00:15:5D': 'Hyper-V', 'D4:6E:0E': 'TP-Link', '00:0E:C6': 'ASIX', '70:85:C2': 'ASRock',
  '2C:F0:5D': 'Micro-Star (MSI)', '00:D8:61': 'Micro-Star (MSI)', '4C:CC:6A': 'Micro-Star (MSI)', 'D8:BB:C1': 'Micro-Star (MSI)',
  'B4:2E:99': 'Gigabyte', '18:C0:4D': 'Gigabyte', 'E0:D5:5E': 'Gigabyte', '04:92:26': 'ASUS', 'A8:5E:45': 'ASUS', '00:23:24': 'Apple',
};
function vendorOf(mac) {
  if (isRandomMac(mac)) return 'случайный адрес — телефон или планшет';
  return OUI[mac.slice(0, 8)] || '';
}

function reverseName(ip, ms = 1200) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(''), ms);
    dns.reverse(ip, (err, names) => { clearTimeout(t); resolve(err || !names || !names.length ? '' : names[0].replace(/\.(lan|local|home|localdomain)$/i, '')); });
  });
}

/** Опрашивает подсеть (UDP-пакеты заставляют систему узнать MAC-адреса) и читает таблицу ARP. */
async function scanDevices(iface) {
  if (!iface || !iface.ip || !iface.netmask) throw new Error('Не найдено подключение к сети');
  const hosts = subnetHosts(iface.ip, iface.netmask);
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, r));
  const payload = Buffer.from([0]);
  for (let i = 0; i < hosts.length; i += 32) {
    for (const h of hosts.slice(i, i + 32)) {
      if (h === iface.ip) continue;
      sock.send(payload, 137, h, () => {});
      sock.send(payload, 9, h, () => {});
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  await new Promise((r) => setTimeout(r, 2500));
  sock.close();
  const arp = IS_WIN ? await run('arp', ['-a'], { timeout: 15000 }) : await run('ip', ['neigh'], { timeout: 15000 });
  const inSubnet = new Set(hosts);
  const list = parseArp(arp.out).filter((x) => inSubnet.has(x.ip));
  let gw = '';
  try { gw = await si.networkGatewayDefault(); } catch (e) { /* нет */ }
  const seen = new Set();
  const out = [];
  for (const d of list) {
    if (seen.has(d.mac)) continue;
    seen.add(d.mac);
    out.push({ ...d, router: d.ip === gw, vendor: vendorOf(d.mac) });
  }
  if (iface.mac) out.push({ ip: iface.ip, mac: iface.mac.toUpperCase().replace(/-/g, ':'), self: true, vendor: 'этот компьютер', router: false });
  await Promise.all(out.map(async (d) => { d.name = d.self ? os.hostname() : await reverseName(d.ip); }));
  out.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
  return out;
}

module.exports = { checkInternet, speedTest, scanDevices, parseArp, subnetHosts, vendorOf, isRandomMac };
