// BPM / key / energy lookup for the Music Lovers "Personal DJ mix" feature.
//
// Spotify's own /v1/audio-features is gone for this app (deprecated for
// apps created after Nov 2024 — every call returns 403), so this module
// assembles the same numbers from what's still free and reachable:
//
//   1. store.js cache  — a track analysed once is never analysed again
//                        (persisted to Redis with the rest of the store).
//   2. GetSongBPM API  — https://getsongbpm.com/api, free key, title +
//                        artist search then a per-song lookup that returns
//                        tempo and key. Coverage is good on charting
//                        material, patchy on remixes/deep cuts. Skipped
//                        entirely when GETSONGBPM_API_KEY is unset.
//   3. iTunes preview   — https://itunes.apple.com/lookup?isrc=… is free
//                        and unauthenticated and still returns a 30-s
//                        previewUrl for most catalogue tracks (Spotify's
//                        own preview_url is the thing that went away, see
//                        demo-notes.md bug 13). The clip is decoded with
//                        ffmpeg-static to mono 11 025 Hz PCM and handed to
//                        lib/audioAnalysis.js.
//
// Whichever source answered, the result shape is the one lib/mixEngine.js
// consumes: { bpm, key, mode, energy, previewUrl, beatOffsetSec, source }.
// previewUrl is kept even when GetSongBPM won the BPM race because
// lib/mixTeaser.js needs the audio anyway.
//
// Everything here is best-effort: a track with no answer from any source
// simply comes back null and the planner leaves it out. Concurrency is
// bounded (PARALLEL) so a 300-track library doesn't open 300 sockets or
// peg the event loop with analysis — ~1 s per track end-to-end on Render.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const { fetchWithTimeout } = require('./httpClient');
const { analysePcm, SAMPLE_RATE } = require('./audioAnalysis');
const { getTrackFeatures: cacheGet, setTrackFeatures: cacheSet } = require('./store');

const PARALLEL = 4;
const PREVIEW_TIMEOUT_MS = 15000;

// ---------- GetSongBPM ----------
const KEY_TO_PITCH = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

// GetSongBPM writes keys as "Am", "C♯m", "Db", "F#"… → { key, mode }.
function parseKeyOf(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.replace('♯', '#').replace('♭', 'b').trim();
  const m = s.match(/^([A-G][#b]?)\s*(m|min|minor)?$/i);
  if (!m) return null;
  const pitch = KEY_TO_PITCH[m[1][0].toUpperCase() + (m[1][1] || '')];
  if (pitch == null) return null;
  return { key: pitch, mode: m[2] ? 0 : 1 };
}

async function lookupGetSongBpm(title, artist) {
  const apiKey = process.env.GETSONGBPM_API_KEY;
  if (!apiKey) return null;
  // Strip the "- Radio Edit" / "(feat. X)" noise Spotify titles carry —
  // GetSongBPM's search is a plain text match and chokes on it.
  const cleanTitle = String(title).replace(/\s*[-(\[].*$/, '').trim() || title;
  const cleanArtist = String(artist).split(/[,;]/)[0].trim();
  const lookup = encodeURIComponent(`song:${cleanTitle} artist:${cleanArtist}`);
  const searchRes = await fetchWithTimeout(`https://api.getsongbpm.com/search/?api_key=${apiKey}&type=both&lookup=${lookup}`);
  const searchJson = await searchRes.json().catch(() => ({}));
  const hit = Array.isArray(searchJson.search) ? searchJson.search[0] : null;
  if (!hit || !hit.id) return null;
  // The search hit sometimes already carries tempo; the per-song lookup
  // always does, plus the key.
  let song = hit;
  if (!hit.tempo || !hit.key_of) {
    const songRes = await fetchWithTimeout(`https://api.getsongbpm.com/song/?api_key=${apiKey}&id=${encodeURIComponent(hit.id)}`);
    const songJson = await songRes.json().catch(() => ({}));
    song = songJson.song || hit;
  }
  const bpm = Number(song.tempo);
  if (!bpm) return null;
  const parsedKey = parseKeyOf(song.key_of);
  return {
    bpm,
    key: parsedKey ? parsedKey.key : null,
    mode: parsedKey ? parsedKey.mode : null,
    // GetSongBPM has danceability (0–100) but not energy — close enough as
    // a stand-in for the arc planner when no preview gets analysed.
    energy: song.danceability ? Math.min(1, Number(song.danceability) / 100) : null,
    source: 'getsongbpm',
  };
}

// ---------- iTunes preview ----------
async function lookupItunesPreview({ isrc, title, artist }) {
  let json = null;
  if (isrc) {
    const res = await fetchWithTimeout(`https://itunes.apple.com/lookup?isrc=${encodeURIComponent(isrc)}&entity=song`);
    json = await res.json().catch(() => null);
  }
  if (!json || !json.resultCount) {
    // ISRC miss (regional releases, remixes): fall back to a text search
    // and take the first result whose artist looks right.
    const term = encodeURIComponent(`${String(artist).split(/[,;]/)[0]} ${String(title).replace(/\s*[-(\[].*$/, '')}`);
    const res = await fetchWithTimeout(`https://itunes.apple.com/search?term=${term}&entity=song&limit=5`);
    json = await res.json().catch(() => null);
  }
  const results = (json && json.results) || [];
  const wantArtist = String(artist).split(/[,;]/)[0].trim().toLowerCase();
  const pick = results.find((r) => r.previewUrl && String(r.artistName || '').toLowerCase().includes(wantArtist)) || results.find((r) => r.previewUrl);
  return pick ? pick.previewUrl : null;
}

// iTunes previews are .m4a (AAC in an MP4 container) and MP4 needs a
// seekable input — piping it through stdin makes ffmpeg exit 0 with zero
// samples — so the buffer goes through a temp file rather than pipe:0
// (the ringtone route's Spotify previews were MP3, which pipes fine).
function decodeToPcm(inputBuffer) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `mix-decode-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.writeFileSync(tmp, inputBuffer);
    const args = ['-hide_banner', '-loglevel', 'error', '-i', tmp, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1'];
    const proc = spawn(ffmpegPath, args);
    const chunks = [];
    const errChunks = [];
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => errChunks.push(c));
    const cleanup = () => fs.rm(tmp, { force: true }, () => {});
    proc.on('error', (err) => {
      cleanup();
      reject(err);
    });
    proc.on('close', (code) => {
      cleanup();
      if (code !== 0) {
        reject(new Error(`ffmpeg (decode) exited ${code}: ${Buffer.concat(errChunks).toString()}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      // Float32Array needs 4-byte alignment; Buffer.concat may not give it.
      const aligned = new Float32Array(buf.length / 4);
      for (let i = 0; i < aligned.length; i++) aligned[i] = buf.readFloatLE(i * 4);
      resolve(aligned);
    });
  });
}

async function analysePreview(previewUrl) {
  const res = await fetchWithTimeout(previewUrl, {}, PREVIEW_TIMEOUT_MS);
  if (!res.ok) throw new Error(`preview download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const pcm = await decodeToPcm(buf);
  const a = analysePcm(pcm);
  if (!a) return null;
  return { bpm: a.bpm, key: a.key, mode: a.mode, energy: a.energy, beatOffsetSec: a.beatOffsetSec, bpmConfidence: a.bpmConfidence, source: 'preview-analysis' };
}

// ---------- public ----------
// track: { id, title, artist, isrc } → features or null. Cached by track id.
async function getFeatures(track) {
  const cached = cacheGet(track.id);
  if (cached !== undefined) return cached; // null is a valid cached "nothing found"

  let features = null;
  let previewUrl = null;
  try {
    previewUrl = await lookupItunesPreview(track);
  } catch (err) {
    console.error(`trackFeatures: iTunes lookup failed for ${track.title}:`, err.message);
  }
  try {
    const api = await lookupGetSongBpm(track.title, track.artist);
    if (api) features = api;
  } catch (err) {
    console.error(`trackFeatures: GetSongBPM failed for ${track.title}:`, err.message);
  }
  if (previewUrl) {
    try {
      const analysed = await analysePreview(previewUrl);
      if (analysed) {
        // API tempo is usually the more trustworthy of the two; keep the
        // analysis' beat offset/energy regardless, and fill any API gaps
        // (unknown key, no danceability) from the analysis.
        features = features
          ? { ...analysed, ...features, key: features.key ?? analysed.key, mode: features.mode ?? analysed.mode, energy: features.energy ?? analysed.energy, source: `${features.source}+preview` }
          : analysed;
      }
    } catch (err) {
      console.error(`trackFeatures: preview analysis failed for ${track.title}:`, err.message);
    }
  }
  if (features) features.previewUrl = previewUrl;
  cacheSet(track.id, features || null);
  return features || null;
}

// Runs getFeatures over many tracks with bounded concurrency and an
// overall time budget (ms) — returns whatever finished in time, in the
// input order, so a giant library still yields a mix within a demo-length
// wait. onProgress(done, total) is optional.
async function getFeaturesForMany(tracks, { budgetMs = 90000, onProgress } = {}) {
  const deadline = Date.now() + budgetMs;
  const results = new Array(tracks.length).fill(undefined);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < tracks.length && Date.now() < deadline) {
      const i = next++;
      results[i] = await getFeatures(tracks[i]);
      done++;
      if (onProgress) onProgress(done, tracks.length);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return results.map((f, i) => (f ? { ...tracks[i], ...f } : null)).filter(Boolean);
}

module.exports = { getFeatures, getFeaturesForMany, parseKeyOf, decodeToPcm };
