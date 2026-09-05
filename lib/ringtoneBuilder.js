// Trims a Spotify preview clip down to a ringtone-length ogg/opus clip with
// fade in/out — see demo-notes.md's "Ringtone follow-up feature". Uses
// ffmpeg-static (bundles a static ffmpeg binary as an npm dependency) so
// this works on Render's standard Node runtime with no Dockerfile or
// buildpack changes needed.
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

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

function runFfmpeg(inputBuffer) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ss', String(CLIP_START_SECONDS),
      '-t', String(CLIP_DURATION_SECONDS),
      '-af', `afade=t=in:st=0:d=${FADE_SECONDS},afade=t=out:st=${CLIP_DURATION_SECONDS - FADE_SECONDS}:d=${FADE_SECONDS}`,
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

// Downloads the given Spotify preview URL and returns a ringtone-length
// ogg/opus Buffer (Content-Type 'audio/ogg'), cached per trackId.
async function buildRingtoneClip(trackId, previewUrl) {
  if (cache.has(trackId)) return cache.get(trackId);

  const res = await fetch(previewUrl);
  if (!res.ok) throw new Error(`Failed to download preview clip: ${res.status}`);
  const inputBuffer = Buffer.from(await res.arrayBuffer());

  const clip = await runFfmpeg(inputBuffer);
  cache.set(trackId, clip);
  return clip;
}

module.exports = { buildRingtoneClip };
