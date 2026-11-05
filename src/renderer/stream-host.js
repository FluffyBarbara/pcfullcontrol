'use strict';
// Скрытое окно трансляции: захват экрана, кодирование (WebRTC) и канал управления с телефоном.
(() => {
  const host = window.host;
  const S = new Map(); // sid -> сеанс
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const log = (...a) => host.log(a.join(' '));

  function size(source, p) {
    const k = Math.min(1, p.maxWidth / source.width);
    return { w: even(source.width * k), h: even(source.height * k) };
  }

  async function captureVideo(source, p) {
    const { w, h } = size(source, p);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxWidth: w, maxHeight: h, maxFrameRate: p.fps } },
      });
    } catch (e) {
      throw new Error('Не удалось захватить экран: ' + (e.message || e.name));
    }
    const track = stream.getVideoTracks()[0];
    track.contentHint = p.hint;
    return { stream, track };
  }

  // Звук ПК (Windows): захват всего системного звука
  async function captureAudio() {
    const st = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop' } },
      video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 320, maxHeight: 240, maxFrameRate: 1 } },
    });
    st.getVideoTracks().forEach((t) => t.stop());
    return st.getAudioTracks()[0] || null;
  }

  function send(s, msg) {
    if (s && s.dc && s.dc.readyState === 'open') {
      try { s.dc.send(JSON.stringify(msg)); } catch (e) { /* канал закрывается */ }
    }
  }

  async function setParams(s) {
    const p = s.preset;
    const params = s.sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    const enc = params.encodings[0];
    enc.maxBitrate = p.bitrate * 1000;
    enc.maxFramerate = p.fps;
    enc.priority = 'high';
    enc.networkPriority = 'high';
    params.degradationPreference = p.degradation;
    try {
      await s.sender.setParameters(params);
    } catch (e) {
      delete params.degradationPreference;
      try { await s.sender.setParameters(params); } catch (e2) { log('setParameters', e2.message); }
    }
  }

  async function applyPreset(s, name) {
    const p = s.presets[name];
    if (!p) return;
    s.presetName = name;
    s.preset = p;
    const { w, h } = size(s.source, p);
    try { await s.track.applyConstraints({ width: { max: w }, height: { max: h }, frameRate: { max: p.fps } }); } catch (e) { log('applyConstraints', e.message); }
    s.track.contentHint = p.hint;
    await setParams(s);
    send(s, { type: 'preset', name });
  }

  async function switchMonitor(s, index) {
    const source = await host.source(index);
    const { stream, track } = await captureVideo(source, s.preset);
    await s.sender.replaceTrack(track);
    s.track.stop();
    s.stream.getVideoTracks().forEach((t) => t.stop());
    s.track = track;
    s.stream = stream;
    s.source = source;
    host.monitor(s.sid, source.index);
    send(s, { type: 'monitor', index: source.index, width: source.width, height: source.height });
  }

  async function stats(s) {
    if (!s.sender) return;
    const r = await s.sender.getStats();
    let out = null;
    r.forEach((x) => { if (x.type === 'outbound-rtp' && x.kind === 'video') out = x; });
    if (!out) return;
    const codec = out.codecId && r.get(out.codecId) ? r.get(out.codecId).mimeType.replace(/^video\//i, '') : '';
    const now = performance.now();
    const kbps = s.lastBytes != null ? Math.round(((out.bytesSent - s.lastBytes) * 8) / (now - s.lastT)) : 0;
    s.lastBytes = out.bytesSent;
    s.lastT = now;
    send(s, {
      type: 'stats', fps: Math.round(out.framesPerSecond || 0), w: out.frameWidth || 0, h: out.frameHeight || 0, codec, kbps,
      encoder: out.encoderImplementation || '', hw: !!out.powerEfficientEncoder, limit: out.qualityLimitationReason || 'none',
      target: s.preset.fps,
    });
  }

  function onMessage(s, data) {
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    switch (m.type) {
      case 'input': host.input(s.sid, m.cmd); break;
      case 'preset': applyPreset(s, m.name).catch((e) => send(s, { type: 'error', message: e.message })); break;
      case 'monitor': switchMonitor(s, m.index).catch((e) => send(s, { type: 'error', message: e.message })); break;
      case 'ping': send(s, { type: 'pong', t: m.t }); break;
      case 'bye': stop(s.sid); break;
      default: break;
    }
  }

  function gathered(pc, ms) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      });
    });
  }

  async function start({ sid, source, preset, presets, audio }) {
    const p = presets[preset];
    const { stream, track } = await captureVideo(source, p);
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    const s = { sid, pc, stream, track, source, presets, preset: p, presetName: preset, dc: null, timer: null, audioTrack: null };
    S.set(sid, s);
    try {
      const tr = pc.addTransceiver(track, {
        direction: 'sendonly', streams: [stream],
        sendEncodings: [{ maxBitrate: p.bitrate * 1000, maxFramerate: p.fps, priority: 'high', networkPriority: 'high' }],
      });
      s.sender = tr.sender;
      try {
        const caps = RTCRtpSender.getCapabilities('video');
        if (caps && tr.setCodecPreferences) tr.setCodecPreferences(window.Sdp.sortCodecs(caps.codecs));
      } catch (e) { log('codecs', e.message); }
      if (audio) {
        try {
          s.audioTrack = await captureAudio();
          if (s.audioTrack) pc.addTransceiver(s.audioTrack, { direction: 'sendonly', streams: [stream] });
        } catch (e) { log('audio', e.message); }
      }
      s.dc = pc.createDataChannel('ctl', { ordered: true });
      s.dc.onmessage = (e) => onMessage(s, e.data);
      s.dc.onopen = () => send(s, { type: 'hello', preset: s.presetName, monitor: source.index, audio: !!s.audioTrack });
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === 'connected') {
          clearTimeout(s.disc);
          clearTimeout(s.noAnswer);
          if (!s.timer) s.timer = setInterval(() => stats(s).catch(() => {}), 1000);
        } else if (st === 'disconnected') {
          clearTimeout(s.disc);
          s.disc = setTimeout(() => stop(sid), 10000);
        } else if (st === 'failed' || st === 'closed') stop(sid);
      };
      s.noAnswer = setTimeout(() => stop(sid), 40000);
      await pc.setLocalDescription();
      await gathered(pc, 2500);
      return { sdp: pc.localDescription.sdp, audio: !!s.audioTrack };
    } catch (e) {
      stop(sid);
      throw e;
    }
  }

  async function answer({ sid, sdp }) {
    const s = S.get(sid);
    if (!s) throw new Error('Сеанс трансляции не найден');
    const b = s.preset.bitrate;
    await s.pc.setRemoteDescription({ type: 'answer', sdp: window.Sdp.tune(sdp, { start: Math.min(b * 0.6, 15000), min: Math.min(1500, b / 2), max: b }) });
    await setParams(s);
    return { ok: true };
  }


  function stop(sid) {
    const s = S.get(sid);
    if (!s) return;
    S.delete(sid);
    clearInterval(s.timer);
    clearTimeout(s.disc);
    clearTimeout(s.noAnswer);
    try { s.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    try { if (s.audioTrack) s.audioTrack.stop(); } catch (e) { /* ignore */ }
    try { s.pc.close(); } catch (e) { /* ignore */ }
    host.closed(sid);
  }

  host.onCommand(async (m) => {
    try {
      let data = null;
      switch (m.type) {
        case 'start': data = await start(m); break;
        case 'answer': data = await answer(m); break;
        case 'stop': stop(m.sid); return;
        case 'cursor':
          for (const [sid, c] of Object.entries(m.cursors || {})) send(S.get(sid), { type: 'cursor', p: c });
          return;
        case 'notify': send(S.get(m.sid), { type: 'error', message: m.error }); return;
        default: return;
      }
      if (m.rid) host.reply(m.rid, true, data);
    } catch (e) {
      if (m.rid) host.reply(m.rid, false, null, e.message || String(e));
    }
  });
  host.ready();
})();
