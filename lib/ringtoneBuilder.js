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

module.exports = { buildRingtoneClip, buildGeneratedRingtoneClip, isCached };
