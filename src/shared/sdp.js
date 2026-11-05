'use strict';
// Настройка описания соединения WebRTC (SDP) для трансляции экрана:
// сразу высокий битрейт (картинка чёткая с первой секунды) и стереозвук.
(function (root) {
  const SKIP = /^(rtx|red|ulpfec|flexfec-03)$/i;

  /**
   * Добавляет к видеокодекам подсказки битрейта (кбит/с), к Opus — стерео и высокий битрейт.
   * @param {string} sdp
   * @param {{start:number,min:number,max:number}} bitrate
   */
  function tune(sdp, bitrate) {
    const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
    const lines = sdp.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    const out = [];
    let kind = null;
    let section = [];
    const flush = () => {
      if (!section.length) return;
      out.push(...(kind === 'video' ? tuneVideo(section, bitrate) : kind === 'audio' ? tuneAudio(section) : section));
      section = [];
    };
    for (const line of lines) {
      if (line.startsWith('m=')) { flush(); kind = line.slice(2).split(' ')[0]; }
      section.push(line);
    }
    flush();
    return out.join(eol) + eol;
  }

  function codecs(section) {
    const map = {};
    for (const l of section) {
      const m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(l);
      if (m) map[m[1]] = m[2];
    }
    return map;
  }

  function tuneVideo(section, b) {
    if (!b) return section;
    const names = codecs(section);
    const extra = `x-google-start-bitrate=${Math.round(b.start)};x-google-min-bitrate=${Math.round(b.min)};x-google-max-bitrate=${Math.round(b.max)}`;
    const withFmtp = new Set();
    const res = section.map((l) => {
      const m = /^a=fmtp:(\d+) (.*)$/.exec(l);
      if (!m || !names[m[1]] || SKIP.test(names[m[1]])) return l;
      withFmtp.add(m[1]);
      const params = m[2].split(';').filter((p) => !/^x-google-(start|min|max)-bitrate=/.test(p.trim()));
      return `a=fmtp:${m[1]} ${[...params, extra].filter(Boolean).join(';')}`;
    });
    // У VP8 строки fmtp обычно нет — добавляем её сразу после rtpmap
    const final = [];
    for (const l of res) {
      final.push(l);
      const m = /^a=rtpmap:(\d+) /.exec(l);
      if (m && names[m[1]] && !SKIP.test(names[m[1]]) && !withFmtp.has(m[1])) final.push(`a=fmtp:${m[1]} ${extra}`);
    }
    return final;
  }

  function tuneAudio(section) {
    const names = codecs(section);
    return section.map((l) => {
      const m = /^a=fmtp:(\d+) (.*)$/.exec(l);
      if (!m || !/^opus$/i.test(names[m[1]] || '')) return l;
      const params = m[2].split(';').filter((p) => !/^(stereo|sprop-stereo|maxaveragebitrate)=/.test(p.trim()));
      return `a=fmtp:${m[1]} ${[...params, 'stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=192000'].join(';')}`;
    });
  }

  /** Порядок кодеков: H.264 (аппаратное кодирование и декодирование почти везде), затем VP9, AV1, VP8. */
  function rankCodec(c) {
    const t = String(c.mimeType || '').toLowerCase();
    const f = String(c.sdpFmtpLine || '');
    if (t === 'video/h264') {
      let r = /packetization-mode=1/.test(f) ? 0 : 1;
      if (/profile-level-id=64/.test(f)) r -= 0.5; // High — чётче при том же битрейте
      return r;
    }
    if (t === 'video/vp9') return 2;
    if (t === 'video/av1') return 3;
    if (t === 'video/vp8') return 4;
    return 9; // rtx, red, ulpfec — служебные, в конец
  }

  function sortCodecs(list) {
    return list.map((c, i) => ({ c, i })).sort((a, b) => rankCodec(a.c) - rankCodec(b.c) || a.i - b.i).map((x) => x.c);
  }

  const api = { tune, sortCodecs, rankCodec };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sdp = api;
})(typeof window !== 'undefined' ? window : globalThis);
