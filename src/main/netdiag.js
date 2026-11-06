'use strict';
// Диагностика обрывов интернета: в момент обрыва проверяем по цепочке — сетевой адаптер → роутер (шлюз) →
// интернет → DNS — и объясняем причину простыми словами с советом и кнопкой «Исправить».
// Исправления (перезапуск адаптера, отключение энергосбережения, DNS) — только по кнопке или по включённой настройке.
const { IS_WIN, powershell } = require('./system/exec');

const DIAG_PS = `$ErrorActionPreference = 'SilentlyContinue'
$cfg = @(Get-NetIPConfiguration | Where-Object { $_.NetAdapter -and $_.NetAdapter.HardwareInterface })
$main = $cfg | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1
if (-not $main) { $main = $cfg | Where-Object { $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1 }
if (-not $main) { $main = $cfg | Select-Object -First 1 }
if (-not $main) { ConvertTo-Json -InputObject ([ordered]@{ none = $true }) -Compress; exit }
$ad = $main.NetAdapter
$alias = [string]$ad.Name
$gw = [string]($main.IPv4DefaultGateway.NextHop | Select-Object -First 1)
$ip = [string]($main.IPv4Address.IPAddress | Select-Object -First 1)
$dns = @($main.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses })
function Ping($h) { if (-not $h) { return $null }; try { [bool](Test-Connection -ComputerName $h -Count 2 -Quiet -ErrorAction Stop) } catch { $false } }
$pgw = Ping $gw; $p1 = Ping '1.1.1.1'; $p8 = Ping '8.8.8.8'
$dnsOk = $false; try { $null = Resolve-DnsName -Name 'ya.ru' -Type A -DnsOnly -QuickTimeout -ErrorAction Stop; $dnsOk = $true } catch {}
$pm = ''; try { $pm = [string](Get-NetAdapterPowerManagement -Name $alias -ErrorAction Stop).AllowComputerToTurnOffDevice } catch {}
$adv = @(Get-NetAdapterAdvancedProperty -Name $alias | Where-Object { $_.DisplayName -match 'Energy|Green|EEE|Энерг|Power Sav|Ultra Low|Gigabit Lite|Эконом|Зелен|Selective Suspend|Idle Power' } | ForEach-Object { [ordered]@{ name = [string]$_.DisplayName; value = [string]$_.DisplayValue; keyword = [string]$_.RegistryKeyword; reg = [string]($_.RegistryValue -join ','); valid = @($_.ValidRegistryValues | ForEach-Object { [string]$_ }) } })
$wifi = $null
$isWifi = ([string]$ad.PhysicalMediaType -match '802\\.11') -or ([string]$ad.MediaType -match '802\\.11') -or ([string]$ad.InterfaceDescription -match 'Wi-?Fi|Wireless|WLAN|802\\.11')
if ($isWifi) {
  $w = (netsh wlan show interfaces) | Out-String
  $sig = if ($w -match '(?m)^\\s*(Сигнал|Signal)\\s*:\\s*(\\d+)%') { [int]$Matches[2] } else { $null }
  $ssid = if ($w -match '(?m)^\\s*SSID\\s*:\\s*(.+)$') { $Matches[1].Trim() } else { '' }
  $wifi = [ordered]@{ signal = $sig; ssid = $ssid }
}
$ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 27, 4202, 10400, 10317; StartTime = (Get-Date).AddHours(-24) } -MaxEvents 300 | Group-Object ProviderName | ForEach-Object { [ordered]@{ provider = [string]$_.Name; count = $_.Count } })
ConvertTo-Json -Depth 4 -Compress -InputObject ([ordered]@{
  alias = $alias; desc = [string]$ad.InterfaceDescription; status = [string]$ad.Status; wifi = $wifi; isWifi = $isWifi
  linkSpeed = [string]$ad.LinkSpeed; driverVersion = [string]$ad.DriverVersionString; driverDate = [string]$ad.DriverDate; driverProvider = [string]$ad.DriverProvider
  ip = $ip; gw = $gw; dns = $dns; pingGw = $pgw; ping1 = $p1; ping8 = $p8; dnsOk = $dnsOk; powerSave = $pm; adv = $adv; events = $ev
})`;

const ENERGY_ON = /^(вкл|on|enabled|включено|да|yes|auto|авто)/i;

/** Что включено из энергосбережения адаптера (то, что часто роняет связь). */
function energyIssues(d) {
  const list = [];
  if (/enabled/i.test(d.powerSave || '')) list.push('Windows может отключать адаптер для экономии энергии');
  for (const a of d.adv || []) {
    const on = ENERGY_ON.test(a.value || '') || (a.reg && a.reg !== '0' && (a.valid || []).includes('0') && !/^(off|выкл|disabled|отключено|нет|no)/i.test(a.value || ''));
    if (on) list.push(`«${a.name}» включено`);
  }
  return list;
}

/** Разбор результатов проверки → причина, объяснение, советы и доступные исправления. */
function analyze(d) {
  if (!d || d.none) return { cause: 'noadapter', title: 'Сетевой адаптер не найден', text: 'Windows не видит ни одного сетевого адаптера.', advice: ['Проверьте, что сетевая карта или Wi-Fi-адаптер включены в BIOS и в «Диспетчере устройств».'], fixes: [] };
  const energy = energyIssues(d);
  const eventsTotal = (d.events || []).reduce((s, e) => s + (e.count || 0), 0);
  const oldDriver = (() => { const t = Date.parse(d.driverDate); return t && Date.now() - t > 2 * 365 * 86400000; })();
  const wire = !d.isWifi;
  const advice = [];
  const fixes = [];
  let cause; let title; let text;
  if (!/^up$/i.test(d.status || '')) {
    cause = 'link';
    title = wire ? 'Пропало подключение по кабелю' : 'Wi-Fi отключился';
    text = wire ? `Адаптер «${d.alias}» сообщает, что кабель не подключён (нет «линка»). Обычно это кабель, разъём или порт роутера — либо адаптер сам «засыпает».`
      : `Компьютер отключился от сети Wi-Fi${d.wifi && d.wifi.ssid ? ` «${d.wifi.ssid}»` : ''}.`;
    if (wire) advice.push('Проверьте кабель и попробуйте другой порт на роутере; при частых обрывах замените кабель.');
    fixes.push('restart');
  } else if (/^169\.254\./.test(d.ip || '')) {
    cause = 'dhcp'; title = 'Роутер не выдал компьютеру адрес';
    text = 'Адаптер подключён, но получил «аварийный» адрес 169.254.x.x — роутер не ответил на запрос адреса (DHCP).';
    advice.push('Перезагрузите роутер. Если повторяется — перезапустите адаптер или задайте компьютеру постоянный адрес.');
    fixes.push('restart');
  } else if (!d.gw) {
    cause = 'nogw'; title = 'Не задан роутер (шлюз)';
    text = 'У сетевого подключения нет адреса роутера — компьютеру некуда отправлять данные в интернет.';
    advice.push('Перезапустите адаптер или перезагрузите роутер.');
    fixes.push('restart');
  } else if (d.pingGw === false && !d.ping1 && !d.ping8) {
    cause = 'gateway'; title = 'Компьютер перестал видеть роутер';
    text = `${d.isWifi ? 'Wi-Fi' : 'Кабель'} подключён, но роутер ${d.gw} не отвечает — «Не удаётся получить доступ к шлюзу по умолчанию». Чаще всего так зависает драйвер сетевого адаптера или его энергосбережение; помогает перезапуск адаптера.`;
    advice.push('Самое надёжное: обновите драйвер сетевой карты с сайта производителя (Realtek, Intel, Killer — по названию адаптера).');
    if (energy.length) advice.push(`Отключите энергосбережение адаптера: ${energy.join('; ')} — частая причина таких обрывов.`);
    advice.push('Пока причина не устранена — включите «Сам перезапускать адаптер при обрыве»: связь будет возвращаться за 10–20 секунд без вашего участия.');
    fixes.push('restart', 'autofix');
    if (energy.length) fixes.push('energy');
  } else if (!d.ping1 && !d.ping8) {
    cause = 'isp'; title = 'Роутер на связи, но интернета нет';
    text = `Компьютер видит роутер ${d.gw}, но дальше роутера сигнал не проходит. Проблема у роутера или у провайдера — компьютер тут ни при чём.`;
    advice.push('Перезагрузите роутер (выключите на 30 секунд). Если не помогло — позвоните провайдеру.');
  } else if (!d.dnsOk) {
    cause = 'dns'; title = 'Не работает DNS — сайты не открываются';
    text = `Интернет есть, но DNS-сервер${(d.dns || []).length ? ` (${d.dns.join(', ')})` : ''} не отвечает, поэтому адреса сайтов не находятся.`;
    advice.push('Переключите DNS на быстрые публичные: 1.1.1.1 и 8.8.8.8.');
    fixes.push('dns');
  } else {
    cause = 'ok'; title = 'Связь в порядке';
    text = 'Сейчас и роутер, и интернет, и DNS отвечают. Если связь пропадала — это был кратковременный сбой.';
  }
  if (cause !== 'gateway' && energy.length && (cause === 'link' || eventsTotal >= 3)) { advice.push(`Отключите энергосбережение адаптера: ${energy.join('; ')}.`); fixes.push('energy'); }
  if (eventsTotal >= 3) advice.push(`За сутки Windows ${eventsTotal} раз отмечала отключение или сброс сетевого адаптера — это признак проблемы с драйвером, кабелем или энергосбережением.`);
  if (oldDriver && cause !== 'isp' && cause !== 'ok') advice.push(`Драйвер адаптера старый (${new Date(Date.parse(d.driverDate)).toLocaleDateString('ru-RU')}) — обновите его.`);
  if (d.wifi && d.wifi.signal != null && d.wifi.signal < 45) advice.push(`Слабый сигнал Wi-Fi: ${d.wifi.signal}%. Поставьте роутер ближе или используйте кабель.`);
  return { cause, title, text, advice, fixes: [...new Set(fixes)], energy, eventsTotal };
}

class NetDiag {
  constructor(ctx) {
    this.ctx = ctx;
    this.last = ctx.db.getSetting('lastNetDiag') || null;
    this.busy = null;
  }

  async run() {
    if (!IS_WIN) return { ts: Date.now() / 1000, ...analyze({ alias: 'eth0', status: 'Up', gw: '', ip: '' }), details: null, unsupported: true };
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const r = await powershell(DIAG_PS, 90000);
      let d;
      try { d = JSON.parse(r.out || '{}'); } catch (e) { throw new Error('Не удалось проверить сеть'); }
      const res = { ts: Date.now() / 1000, ...analyze(d), details: d };
      this.last = res;
      this.ctx.db.setSetting('lastNetDiag', res);
      return res;
    })().finally(() => { this.busy = null; });
    return this.busy;
  }

  alias() { return (this.last && this.last.details && this.last.details.alias) || null; }

  async restartAdapter(alias = this.alias()) {
    if (!alias) throw new Error('Сначала проверьте сеть — нужно знать, какой адаптер перезапускать');
    const r = await powershell(`Restart-NetAdapter -Name '${String(alias).replace(/'/g, "''")}' -Confirm:$false -ErrorAction Stop; 'ok'`, 60000);
    if (!/ok/.test(r.out)) throw new Error(r.out.split('\n')[0] || 'Не удалось перезапустить адаптер');
    this.ctx.db.addEvent('info', 'network', `Перезапущен сетевой адаптер «${alias}»`);
    return { ok: true };
  }

  /** Выключает энергосбережение адаптера (прежние значения запоминаются — их можно вернуть). */
  async disableEnergySaving(alias = this.alias()) {
    if (!alias) throw new Error('Сначала проверьте сеть');
    const a = String(alias).replace(/'/g, "''");
    const r = await powershell(`$ErrorActionPreference = 'Stop'
$changed = @()
try { $p = Get-NetAdapterPowerManagement -Name '${a}'; if ([string]$p.AllowComputerToTurnOffDevice -eq 'Enabled') { $p.AllowComputerToTurnOffDevice = 'Disabled'; $p | Set-NetAdapterPowerManagement; $changed += [ordered]@{ kind = 'pm'; prev = 'Enabled' } } } catch {}
foreach ($x in @(Get-NetAdapterAdvancedProperty -Name '${a}' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Energy|Green|EEE|Энерг|Power Sav|Ultra Low|Gigabit Lite|Эконом|Зелен' })) {
  $prev = [string]($x.RegistryValue -join ',')
  if ($prev -ne '0' -and @($x.ValidRegistryValues) -contains '0') {
    try { Set-NetAdapterAdvancedProperty -Name '${a}' -RegistryKeyword $x.RegistryKeyword -RegistryValue 0 -NoRestart; $changed += [ordered]@{ kind = 'adv'; keyword = [string]$x.RegistryKeyword; name = [string]$x.DisplayName; prev = $prev } } catch {}
  }
}
if ($changed.Count) { Restart-NetAdapter -Name '${a}' -Confirm:$false }
ConvertTo-Json -InputObject @($changed) -Compress -Depth 3`, 90000);
    let changed = [];
    try { changed = JSON.parse(r.out || '[]'); } catch (e) { changed = []; }
    if (changed.length) {
      this.ctx.db.setSetting('netEnergyBackup', { alias, changed, ts: Date.now() / 1000 });
      this.ctx.db.addEvent('info', 'network', `Отключено энергосбережение адаптера «${alias}»: ${changed.map((c) => c.name || 'разрешение отключать устройство').join(', ')}`);
    }
    return { changed };
  }

  async restoreEnergySaving() {
    const b = this.ctx.db.getSetting('netEnergyBackup');
    if (!b) throw new Error('Нечего возвращать');
    const a = String(b.alias).replace(/'/g, "''");
    const lines = b.changed.map((c) => (c.kind === 'pm'
      ? `try { $p = Get-NetAdapterPowerManagement -Name '${a}'; $p.AllowComputerToTurnOffDevice = 'Enabled'; $p | Set-NetAdapterPowerManagement } catch {}`
      : `try { Set-NetAdapterAdvancedProperty -Name '${a}' -RegistryKeyword '${String(c.keyword).replace(/'/g, "''")}' -RegistryValue '${String(c.prev).split(',')[0].replace(/'/g, "''")}' -NoRestart } catch {}`));
    await powershell(`${lines.join('\n')}\nRestart-NetAdapter -Name '${a}' -Confirm:$false\n'ok'`, 90000);
    this.ctx.db.setSetting('netEnergyBackup', null);
    return { ok: true };
  }

  /** DNS 1.1.1.1 и 8.8.8.8 (или вернуть автоматические). */
  async setDns(alias = this.alias(), reset = false) {
    if (!alias) throw new Error('Сначала проверьте сеть');
    const a = String(alias).replace(/'/g, "''");
    const r = await powershell(reset
      ? `Set-DnsClientServerAddress -InterfaceAlias '${a}' -ResetServerAddresses -ErrorAction Stop; 'ok'`
      : `Set-DnsClientServerAddress -InterfaceAlias '${a}' -ServerAddresses ('1.1.1.1','8.8.8.8') -ErrorAction Stop; Clear-DnsClientCache; 'ok'`, 30000);
    if (!/ok/.test(r.out)) throw new Error(r.out.split('\n')[0] || 'Не удалось изменить DNS');
    this.ctx.db.addEvent('info', 'network', reset ? `DNS адаптера «${alias}» — снова автоматически` : `DNS адаптера «${alias}»: 1.1.1.1 и 8.8.8.8`);
    return { ok: true };
  }
}

module.exports = { NetDiag, analyze, energyIssues };
