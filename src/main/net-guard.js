'use strict';
// Кто может подключиться к серверу для телефона. Только устройства из домашней сети:
//  • соединение пришло на настоящий сетевой адаптер (Wi-Fi или кабель) — не VPN, не виртуальный;
//  • адрес компьютера на этом адаптере — домашний (192.168.x.x, 10.x.x.x, 172.16–31.x.x);
//  • адрес телефона — из той же подсети, что и компьютер.
// Подключения через VPN (в том числе когда провайдер VPN пускает к клиентам друг друга),
// из интернета (если у компьютера «белый» адрес) и из чужих подсетей обрываются сразу.
const os = require('os');

const VIRTUAL = /virtual|vmware|vbox|virtualbox|hyper-v|vethernet|wsl|docker|loopback|bluetooth|npcap|wintun|wireguard|openvpn|tap-windows|(^|[^a-z])(tun|tap|wg|ppp|utun)\d*([^a-z]|$)|vpn|outline|happ|xray|v2ray|sing-?box|clash|hiddify|nekobox|nekoray|amnezia|radmin|hamachi|zerotier|tailscale|nordlynx|proton|mullvad|windscribe|surfshark|express|warp|cloudflare|kaspersky secure|adguard|forticlient|anyconnect|cisco|globalprotect|pangp|softether|ipsec|l2tp|pptp|sstp/i;

const ip4 = (s) => String(s || '').replace(/^::ffff:/i, '');
function toInt(ip) {
  const p = ip4(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function isPrivate(ip) {
  const n = toInt(ip);
  if (n == null) return false;
  return (n >>> 24) === 10 || (n >>> 20) === ((172 << 4) | 1) || (n >>> 16) === ((192 << 8) | 168);
}
const isLoopback = (ip) => /^127\./.test(ip4(ip)) || ip === '::1';
function sameSubnet(a, b, mask) {
  const x = toInt(a); const y = toInt(b); const m = toInt(mask);
  if (x == null || y == null || m == null || m === 0) return false;
  return ((x & m) >>> 0) === ((y & m) >>> 0);
}

class NetGuard {
  /** physical: Set имён настоящих адаптеров (Windows) или null, пока неизвестно. */
  constructor({ interfaces = () => os.networkInterfaces(), physical = null } = {}) {
    this.interfaces = interfaces;
    this.physical = physical;
    this.openWifi = new Set(); // открытые сети Wi-Fi без пароля — там трафик видят все вокруг
    this.nets = [];
    this.stamp = '';
    this.refresh();
  }

  setPhysical(names) { this.physical = names ? new Set(names) : null; this.refresh(true); }

  /** Сети, из которых разрешены подключения: [{ iface, address, netmask }]. */
  refresh(force = false) {
    const all = this.interfaces() || {};
    const stamp = JSON.stringify(Object.entries(all).map(([k, v]) => [k, (v || []).map((a) => a.address)]));
    if (!force && stamp === this.stamp) return false;
    this.stamp = stamp;
    const nets = [];
    for (const [name, addrs] of Object.entries(all)) {
      if (VIRTUAL.test(name)) continue;
      for (const a of addrs || []) {
        if (!(a.family === 'IPv4' || a.family === 4) || a.internal || !isPrivate(a.address)) continue;
        // Мобильный хот-спот Windows (192.168.137.1) — виртуальный адаптер, но телефон подключён прямо к ПК
        const hotspot = /^192\.168\.137\.1$/.test(a.address);
        if (this.physical && !this.physical.has(name) && !hotspot) continue;
        nets.push({ iface: name, address: a.address, netmask: a.netmask || '255.255.255.0' });
      }
    }
    this.nets = nets;
    return true;
  }

  /** → { ok, reason, iface } */
  check(localAddress, remoteAddress) {
    const local = ip4(localAddress);
    const remote = ip4(remoteAddress);
    if (isLoopback(remote)) return { ok: true, reason: 'этот компьютер' };
    const net = this.nets.find((n) => n.address === local);
    if (net && this.openWifi.has(net.iface)) return { ok: false, reason: 'открытая сеть Wi-Fi без пароля — в ней любой может подслушать связь', iface: net.iface };
    if (!net) return { ok: false, reason: isPrivate(local) ? 'подключение через VPN или виртуальный адаптер' : 'подключение не из домашней сети' };
    if (!isPrivate(remote) || !sameSubnet(remote, net.address, net.netmask)) return { ok: false, reason: 'адрес не из вашей домашней сети', iface: net.iface };
    return { ok: true, iface: net.iface };
  }
}

/** Имена настоящих адаптеров Windows (Wi-Fi, кабель) — без VPN и виртуальных. */
const PHYSICAL_PS = "@(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.HardwareInterface -and -not $_.Virtual } | ForEach-Object { $_.Name }) | ConvertTo-Json -Compress";

/** Состояние Wi-Fi по-английски и по-русски не важно: ищем признаки шифрования в описании подключения. */
const OPEN_WIFI_PS = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; netsh wlan show interfaces | Out-String';
function openWifiNames(out) {
  const names = [];
  for (const block of String(out || '').split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => /:/.test(l));
    if (!lines.length || !/^\s*SSID\s*:/m.test(block)) continue; // не подключено
    const name = lines[0].slice(lines[0].indexOf(':') + 1).trim();
    if (name && !/WPA|WEP|802\.1X|RSNA|SAE|OWE|CCMP|GCMP|TKIP/i.test(block)) names.push(name);
  }
  return names;
}

module.exports = { NetGuard, PHYSICAL_PS, OPEN_WIFI_PS, openWifiNames, isPrivate, sameSubnet, VIRTUAL };
