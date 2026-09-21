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
// Rendering is one ffmpeg-static invocation with a filter graph:
//   per clip:  atrim (from beat offset, N beats long) → atempo (to set BPM)
//              → loudnorm (level-match previews mastered decades apart)
//   then:      acrossfade chained pairwise, 4 beats each
//   out:       ogg/opus 64 kbps — same container/codec the ringtone route
//              already serves WhatsApp successfully.
// Roughly 3–6 s of CPU for 6 clips on Render's standard instance; the
// result is cached in memory keyed by the set id so WhatsApp's media fetch
// (which can hit the URL more than once) never re-renders.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const { fetchWithTimeout } = require('./httpClient');

const CLIPS = 6; // tracks sampled from the set
const BEATS_PER_CLIP = 48; // ~23 s at 125 BPM — 6 clips ≈ 2 min
const CROSSFADE_BEATS = 4;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const cache = new Map(); // setId -> { buffer, at }

function pruneCache() {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_TTL_MS) cache.delete(k);
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

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    const out = [];
    const err = [];
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => err.push(c));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg (teaser) exited ${code}: ${Buffer.concat(err).toString().slice(-800)}`));
    });
  });
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
    const files = [];
    for (let i = 0; i < clips.length; i++) {
      const buf = await download(clips[i].previewUrl);
      const p = path.join(tmpDir, `clip${i}.m4a`);
      fs.writeFileSync(p, buf);
      files.push(p);
    }

    const beatTarget = 60 / targetBpm;
    const filters = [];
    const labels = [];
    clips.forEach((t, i) => {
      // Beat length in the preview's own timeline, at the folded tempo the
      // planner reasons in (bpm = rawBpm × tempoFactor).
      const beatSrc = 60 / t.bpm;
      const ratio = Math.min(1.25, Math.max(0.8, targetBpm / t.bpm)); // atempo sanity range
      let beats = BEATS_PER_CLIP;
      let start = (t.beatOffsetSec || 0) + 8 * beatSrc; // skip the first two bars of the preview
      if (start + beats * beatSrc > 29.5) start = t.beatOffsetSec || 0;
      if (start + beats * beatSrc > 29.5) beats = 16;
      const dur = beats * beatSrc;
      filters.push(
        `[${i}:a]atrim=start=${start.toFixed(3)}:duration=${dur.toFixed(3)},asetpts=PTS-STARTPTS,` +
          `atempo=${ratio.toFixed(4)},loudnorm=I=-14:TP=-1.5:LRA=11,aformat=sample_rates=48000:channel_layouts=stereo[c${i}]`
      );
      labels.push(`[c${i}]`);
    });
    // Chain crossfades: [c0][c1]acrossfade -> [x1]; [x1][c2]acrossfade -> [x2]; …
    const xf = (CROSSFADE_BEATS * beatTarget).toFixed(3);
    let prev = labels[0];
    for (let i = 1; i < labels.length; i++) {
      const out = i === labels.length - 1 ? '[out]' : `[x${i}]`;
      filters.push(`${prev}${labels[i]}acrossfade=d=${xf}:c1=tri:c2=tri${out}`);
      prev = out;
    }
    const args = ['-hide_banner', '-loglevel', 'error'];
    for (const f of files) args.push('-i', f);
    args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg', 'pipe:1');
    const buffer = await runFfmpeg(args);
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
