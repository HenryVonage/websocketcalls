// Trims a Spotify preview clip down to a ringtone-length ogg/opus clip with
// fade in/out — see demo-notes.md's "Ringtone follow-up feature". Uses
// ffmpeg-static (bundles a static ffmpeg binary as an npm dependency) so
// this works on Render's standard Node runtime with no Dockerfile or
// buildpack changes needed.
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { fetchWithTimeout } = require('./httpClient');
const { generateGenreClip } = require('./elevenLabsMusic');

// Small in-memory cache keyed by trackId — WhatsApp/Vonage may (re)fetch
// the audio message's URL more than once for the same send, and re-running
// ffmpeg for a clip that never changes is wasted work. Lost on a Render
// restart, same tradeoff as the rest of store.js's in-memory state — fine
// here since the clip regenerates itself from Spotify on the next request.
const cache = new Map();

// Ringtone-length choices, not preview-length ones — the Spotify preview
// is already ~30s, so this just picks a punchier slice of it rather than
// trying to detect the song's actual hook (no audio analysis here — see
// the design notes: "no real hook-detection needed").
const CLIP_START_SECONDS = 4; // skip the first few seconds' quiet intro
const CLIP_DURATION_SECONDS = 10;
const FADE_SECONDS = 1.5;

// startSeconds defaults to skipping a real recording's quiet intro
// (CLIP_START_SECONDS); an ElevenLabs-generated clip has no such intro, so
// buildGeneratedRingtoneClip below passes startSeconds: 0 instead.
function runFfmpeg(inputBuffer, { startSeconds = CLIP_START_SECONDS, durationSeconds = CLIP_DURATION_SECONDS } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ss', String(startSeconds),
      '-t', String(durationSeconds),
      '-af', `afade=t=in:st=0:d=${FADE_SECONDS},afade=t=out:st=${durationSeconds - FADE_SECONDS}:d=${FADE_SECONDS}`,
      '-c:a', 'libopus', '-b:a', '64k',
      '-f', 'ogg',
      'pipe:1',
    ];
    const proc = spawn(ffmpegPath, args);
    const chunks = [];
    const errChunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => errChunks.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errChunks).toString()}`));
    });
    proc.stdin.on('error', () => {}); // ffmpeg closing stdin early on a bad input shouldn't crash the process
    proc.stdin.write(inputBuffer);
    proc.stdin.end();
  });
}

// Whether a ready clip is already cached for this track — lets a caller
// skip the Spotify preview-URL lookup entirely on a cache hit instead of
// only saving the ffmpeg step (see buildRingtoneClip below).
function isCached(trackId) {
  return cache.has(trackId);
}

// Downloads the given Spotify preview URL and returns a ringtone-length
// ogg/opus Buffer (Content-Type 'audio/ogg'), cached per trackId.
async function buildRingtoneClip(trackId, previewUrl) {
  if (cache.has(trackId)) return cache.get(trackId);

  const res = await fetchWithTimeout(previewUrl);
  if (!res.ok) throw new Error(`Failed to download preview clip: ${res.status}`);
  const inputBuffer = Buffer.from(await res.arrayBuffer());

  const clip = await runFfmpeg(inputBuffer);
  cache.set(trackId, clip);
  return clip;
}

// Fallback path for when Spotify has no preview_url for this track (as of
// Sept 2026, the common case rather than the exception — see
// elevenLabsMusic.js's header comment). Generates a genre-matched
// instrumental via the ElevenLabs Music API instead of downloading real
// audio, then runs it through the same trim/fade/ogg pipeline as a real
// Spotify preview — starting at 0s since a generated clip has no intro to
// skip. Cached under the same trackId key as buildRingtoneClip above (a
// route/prewarm caller doesn't need to know which source ultimately filled
// the cache), so a second listener matched to the same track reuses the
// first generated clip rather than spending more ElevenLabs credits.
// Returns null (never throws) on any generation failure, same
// non-throwing convention as the rest of this codebase's API wrappers —
// callers decide how to respond (see server.js's ringtone route).
async function buildGeneratedRingtoneClip(trackId, genre) {
  if (cache.has(trackId)) return cache.get(trackId);

  const raw = await generateGenreClip(genre);
  if (!raw) return null;

  const clip = await runFfmpeg(raw, { startSeconds: 0, durationSeconds: CLIP_DURATION_SECONDS });
  cache.set(trackId, clip);
  return clip;
}

// Raw-PCM variant of the same short clip, built for realtimeBridge.js's
// call-intro feature (Sept 2026, Henry: play ~2s of the matched song solo
// right as a Music Lovers call connects, then duck it under the agent's
// opening for ~3s more — see realtimeBridge.js's intro-mixing code, and
// MUSIC_LOVERS_CALL_INTRO_ENABLED there for how to turn this off again).
// Reuses buildRingtoneClip/buildGeneratedRingtoneClip's own cache and
// source-resolution (real Spotify preview when available, else the
// ElevenLabs genre-matched fallback) so this never re-fetches or
// re-generates audio a ringtone request already produced for the same
// track — just runs a second, cheap ffmpeg pass turning that clip into raw
// PCM16 at the call's own sample rate instead of WhatsApp's ogg/opus.
const introClipCache = new Map();
const CALL_INTRO_SECONDS = 5;

// Decodes an already-trimmed ogg/opus clip (buildRingtoneClip's own 10s
// output, which already has a 1.5s fade-in baked in — a nice gentle start
// for the "solo" opening seconds) down to CALL_INTRO_SECONDS of raw PCM16
// mono at `sampleRate`, with its own short fade-out at the very end so it
// doesn't click when the call's background-mixing window ends.
function runFfmpegToRawPcm(inputBuffer, sampleRate) {
  return new Promise((resolve, reject) => {
    const fadeStart = CALL_INTRO_SECONDS - 0.4;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-t', String(CALL_INTRO_SECONDS),
      '-af', `afade=t=out:st=${fadeStart}:d=0.4`,
      '-ac', '1', '-ar', String(sampleRate),
      '-f', 's16le',
      'pipe:1',
    ];
    const proc = spawn(ffmpegPath, args);
    const chunks = [];
    const errChunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => errChunks.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg (raw PCM) exited ${code}: ${Buffer.concat(errChunks).toString()}`));
    });
    proc.stdin.on('error', () => {}); // same reasoning as runFfmpeg above
    proc.stdin.write(inputBuffer);
    proc.stdin.end();
  });
}

// previewUrl/genre: same two-way source decision every other caller here
// makes (musicLoversFlow.js's sendRingtone) — pass a real Spotify preview
// URL when one exists, otherwise a genre for the ElevenLabs fallback.
// Returns null (never throws) if neither is available, or if generation
// fails — realtimeBridge.js's caller treats that as "no intro this call"
// rather than delaying or breaking anything.
async function buildCallIntroClip(trackId, previewUrl, genre, sampleRate = 16000) {
  const cacheKey = `${trackId}:${sampleRate}`;
  if (introClipCache.has(cacheKey)) return introClipCache.get(cacheKey);

  let source = null;
  if (previewUrl) {
    source = await buildRingtoneClip(trackId, previewUrl);
  } else if (genre) {
    source = await buildGeneratedRingtoneClip(trackId, genre);
  }
  if (!source) return null;

  const pcm = await runFfmpegToRawPcm(source, sampleRate);
  introClipCache.set(cacheKey, pcm);
  return pcm;
}

module.exports = { buildRingtoneClip, buildGeneratedRingtoneClip, isCached, buildCallIntroClip };
