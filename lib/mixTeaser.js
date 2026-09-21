// Beat-matched "teaser" render for the Music Lovers "Personal DJ mix"
// feature: ~2 minutes of audio stitched from the 30-second iTunes previews
// of a handful of tracks in the planned set, each tempo-stretched to the
// set's tempo and cut on its beat grid, crossfaded on a 4-beat boundary.
//
// This is deliberately a *teaser*, not the mix: previews are 30 s and the
// full tracks aren't licensable through any API, so the real hour-long
// journey lives in the Spotify playlist lib/musicLoversMix.js creates on
// the listener's account. The teaser is what makes the WhatsApp audio
// bubble worth tapping — it proves the transitions actually work.
//
// Rendering, in three cheap steps (memory matters: Render's Starter
// instance has 512 MB and the first live run (Sept 2026) OOM-restarted
// the service mid-render when this was one ffmpeg filter graph with six
// chained `acrossfade`s — each stage buffers its whole input before it
// can fade, so the chain held several hundred MB of float PCM at once):
//   1. per clip, ONE small ffmpeg run: atrim (from the beat offset, N
//      beats long) → atempo (to the set BPM) → dynaudnorm (streaming
//      level-match, unlike loudnorm) → raw s16 48 kHz stereo to stdout
//      (~4.5 MB for a 23-s clip). Sequential, `-threads 1`.
//   2. the crossfades are done here in Node on those Int16 buffers —
//      equal-power fade over CROSSFADE_BEATS — into one ~25 MB buffer.
//   3. one more ffmpeg run encodes that buffer to ogg/opus 64 kbps, the
//      same container/codec the ringtone route already serves WhatsApp.
// Peak memory is now one clip's PCM plus the output buffer.
//
// Cache: finished teasers are kept in memory for 72 h (WhatsApp fetches
// the URL when the message is delivered, which can be hours later on a
// phone that's off), but only the newest CACHE_MAX are held at ~1 MB
// each — anything evicted is re-rendered from the stored plan on demand
// (server.js's route → lib/musicLoversMix.js renderTeaserForSet).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const { fetchWithTimeout } = require('./httpClient');

const CLIPS = 6; // tracks sampled from the set
const BEATS_PER_CLIP = 48; // ~23 s at 125 BPM — 6 clips ≈ 2 min
const CROSSFADE_BEATS = 4;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const CACHE_TTL_MS = 72 * 60 * 60 * 1000;
const CACHE_MAX = 12;

const cache = new Map(); // setId -> { buffer, at }

function pruneCache() {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_TTL_MS) cache.delete(k);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// Picks CLIPS tracks spread evenly across the set (first, last, and
// evenly-spaced between) that actually have a preview to render from.
function chooseClips(planTracks) {
  const withPreview = planTracks.filter((t) => t.previewUrl);
  if (withPreview.length <= CLIPS) return withPreview;
  const out = [];
  for (let i = 0; i < CLIPS; i++) {
    const idx = Math.round((i * (withPreview.length - 1)) / (CLIPS - 1));
    if (!out.includes(withPreview[idx])) out.push(withPreview[idx]);
  }
  return out;
}

async function download(url) {
  if (url.startsWith('file:')) return fs.readFileSync(new URL(url)); // tests
  const res = await fetchWithTimeout(url, {}, 15000);
  if (!res.ok) throw new Error(`preview download failed ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function runFfmpeg(args, stdinBuffer) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-threads', '1', ...args]);
    const out = [];
    const err = [];
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => err.push(c));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg (teaser) exited ${code}: ${Buffer.concat(err).toString().slice(-800)}`));
    });
    proc.stdin.on('error', () => {});
    if (stdinBuffer) proc.stdin.end(stdinBuffer);
    else proc.stdin.end();
  });
}

// Step 1: one clip → raw s16le 48 kHz stereo PCM at the set tempo.
async function renderClipPcm(file, track, targetBpm) {
  // Beat length in the preview's own timeline, at the folded tempo the
  // planner reasons in (bpm = rawBpm × tempoFactor).
  const beatSrc = 60 / track.bpm;
  const ratio = Math.min(1.25, Math.max(0.8, targetBpm / track.bpm)); // atempo sanity range
  let beats = BEATS_PER_CLIP;
  let start = (track.beatOffsetSec || 0) + 8 * beatSrc; // skip the first two bars of the preview
  if (start + beats * beatSrc > 29.5) start = track.beatOffsetSec || 0;
  if (start + beats * beatSrc > 29.5) beats = 16;
  const dur = beats * beatSrc;
  const af = `atrim=start=${start.toFixed(3)}:duration=${dur.toFixed(3)},asetpts=PTS-STARTPTS,atempo=${ratio.toFixed(4)},dynaudnorm=f=200:g=15:p=0.9`;
  return runFfmpeg(['-i', file, '-af', af, '-f', 's16le', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), 'pipe:1']);
}

// Step 2: equal-power crossfade of consecutive Int16 stereo buffers.
function crossfadeAll(pcms, fadeFrames) {
  const frameBytes = CHANNELS * 2;
  const fadeBytes = fadeFrames * frameBytes;
  let totalBytes = pcms.reduce((a, b) => a + b.length, 0) - fadeBytes * (pcms.length - 1);
  totalBytes -= totalBytes % frameBytes;
  const out = Buffer.alloc(totalBytes);
  let pos = 0;
  pcms.forEach((pcm, i) => {
    const usable = pcm.length - (pcm.length % frameBytes);
    if (i === 0) {
      pcm.copy(out, 0, 0, usable);
      pos = usable;
      return;
    }
    const overlapStart = pos - fadeBytes;
    for (let f = 0; f < fadeFrames; f++) {
      const t = f / fadeFrames;
      const gOut = Math.cos((t * Math.PI) / 2);
      const gIn = Math.sin((t * Math.PI) / 2);
      for (let c = 0; c < CHANNELS; c++) {
        const offOut = overlapStart + f * frameBytes + c * 2;
        const offIn = f * frameBytes + c * 2;
        if (offOut + 1 >= out.length || offIn + 1 >= usable) continue;
        const mixed = out.readInt16LE(offOut) * gOut + pcm.readInt16LE(offIn) * gIn;
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mixed))), offOut);
      }
    }
    const tail = usable - fadeBytes;
    const copyLen = Math.min(tail, out.length - pos);
    if (copyLen > 0) pcm.copy(out, pos, fadeBytes, fadeBytes + copyLen);
    pos += Math.max(0, copyLen);
  });
  return out;
}

/**
 * buildTeaser(setId, planTracks, targetBpm) -> Buffer (ogg/opus)
 * planTracks: lib/mixEngine.js output entries (need previewUrl, bpm,
 * tempoFactor, beatOffsetSec). targetBpm: the set's median BPM.
 */
async function buildTeaser(setId, planTracks, targetBpm) {
  pruneCache();
  const hit = cache.get(setId);
  if (hit) return hit.buffer;

  const clips = chooseClips(planTracks);
  if (clips.length < 2) throw new Error('not enough previews to render a teaser');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-teaser-'));
  try {
    const pcms = [];
    for (let i = 0; i < clips.length; i++) {
      const file = path.join(tmpDir, `clip${i}.m4a`);
      fs.writeFileSync(file, await download(clips[i].previewUrl));
      try {
        const pcm = await renderClipPcm(file, clips[i], targetBpm);
        if (pcm.length > SAMPLE_RATE * CHANNELS * 2 * 4) pcms.push(pcm); // skip anything under 4 s
      } catch (err) {
        console.error(`mixTeaser: clip ${i} (${clips[i].title}) failed, skipping:`, err.message);
      }
      fs.rmSync(file, { force: true });
    }
    if (pcms.length < 2) throw new Error('not enough clips rendered for a teaser');

    const fadeFrames = Math.round((CROSSFADE_BEATS * 60) / targetBpm * SAMPLE_RATE);
    const mixed = crossfadeAll(pcms, fadeFrames);
    pcms.length = 0;
    const buffer = await runFfmpeg(
      ['-f', 's16le', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), '-i', 'pipe:0', '-af', 'afade=t=out:st=' + Math.max(0, mixed.length / (SAMPLE_RATE * CHANNELS * 2) - 3).toFixed(2) + ':d=3', '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg', 'pipe:1'],
      mixed
    );
    cache.set(setId, { buffer, at: Date.now() });
    return buffer;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function isCached(setId) {
  return cache.has(setId);
}

module.exports = { buildTeaser, isCached, chooseClips };
