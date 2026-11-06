'use strict';
// Обложка трека из открытых каталогов музыки (Deezer, затем iTunes), если плеер её не передал Windows.
// Отправляется только исполнитель и название трека. Отключается в настройках («Обложки из интернета»).

/** «Get Lucky (feat. Pharrell) [Remastered] Prod. By X» → «Get Lucky». */
function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*[([](feat|ft|prod|при уч|remaster|official|lyric|audio|video|slowed|sped|speed|reverb|bass|remix|mood|version)[^)\]]*[)\]]/gi, '')
    .replace(/\s+(feat\.?|ft\.?|prod\.?\s*by|при участии)\s.+$/i, '')
    .replace(/\s+(slowed|sped up|speed up|reverb)(\s.*)?$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
const cleanArtist = (a) => String(a || '').split(/\s*(?:,|&|\sfeat\.?\s|\sft\.?\s|\sx\s|×)\s*/i)[0].trim();
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');

async function getJson(url, ms = 6000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'PCFullControl' } });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}

async function getImage(url, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!/^image\//.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 500 && buf.length < 4e6 ? { buf, type } : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}

/** Похож ли найденный трек на то, что играет (чтобы не показать чужую обложку). */
function matches(hit, artist, title) {
  const a = norm(artist); const t = norm(title);
  const ha = norm(hit.artist); const ht = norm(hit.title);
  const artistOk = !a || ha.includes(a) || a.includes(ha);
  const titleOk = !t || ht.includes(t) || t.includes(ht);
  return artistOk && titleOk;
}

async function deezer(artist, title) {
  const qs = [];
  if (artist) qs.push(`artist:"${artist}" track:"${title}"`);
  qs.push(`${artist} ${title}`.trim());
  for (const q of qs) {
    const j = await getJson(`https://api.deezer.com/search?limit=5&q=${encodeURIComponent(q)}`);
    const hit = ((j && j.data) || []).map((d) => ({ artist: d.artist && d.artist.name, title: d.title, url: d.album && (d.album.cover_xl || d.album.cover_big) }))
      .find((d) => d.url && matches(d, artist, title));
    if (hit) return hit.url;
  }
  return null;
}

async function itunes(artist, title) {
  const j = await getJson(`https://itunes.apple.com/search?entity=song&limit=5&term=${encodeURIComponent(`${artist} ${title}`.trim())}`);
  const hit = ((j && j.results) || []).map((d) => ({ artist: d.artistName, title: d.trackName, url: d.artworkUrl100 }))
    .find((d) => d.url && matches(d, artist, title));
  return hit ? hit.url.replace(/\/\d+x\d+bb\./, '/600x600bb.') : null;
}

/** → { buf, type, source } или null */
async function findCover(artist, title) {
  const a = cleanArtist(artist);
  const t = cleanTitle(title);
  if (!t) return null;
  for (const [name, fn] of [['Deezer', deezer], ['iTunes', itunes]]) {
    const url = await fn(a, t).catch(() => null);
    if (!url) continue;
    const img = await getImage(url);
    if (img) return { ...img, source: name };
  }
  return null;
}

module.exports = { findCover, cleanTitle, cleanArtist, matches };
