// Generates a short, royalty-free, genre-matched instrumental clip via
// ElevenLabs' Music API (POST /v1/music) — the fallback ringtone source
// for when Spotify's own preview_url is unavailable for a track (see
// demo-notes.md's "Ringtone follow-up feature"). Spotify restricted
// preview_url on its Web API for standard developer apps around late
// 2024; as of Sept 2026 this fallback fires for essentially every track,
// not just an unlucky few, so this is the primary path in practice even
// though lib/spotifyApi.js's real preview lookup is still tried first.
//
// Deliberately prompts on genre + mood only, never a specific real
// artist's name or style — avoids anything that reads as imitating a
// named musician, and keeps one prompt reusable across every track in a
// genre bucket.
const { fetchWithTimeout } = require('./httpClient');

const MUSIC_GENERATE_TIMEOUT_MS = 30000; // generation is slower than a typical API call

const GENRE_PROMPTS = {
  Pop: 'A short upbeat, catchy pop instrumental with bright synths, handclaps and a driving beat. Purely instrumental, no vocals.',
  'Hip-Hop/Rap': 'A short energetic hip-hop instrumental with heavy 808 bass and crisp hi-hats. Purely instrumental, no vocals.',
  'Indie/Alt': 'A short warm indie alternative instrumental with jangly guitars and a laid-back groove. Purely instrumental, no vocals.',
  Electronic: 'A short pulsing electronic dance instrumental with a driving four-on-the-floor beat and bright synth leads. Purely instrumental, no vocals.',
  'R&B': 'A short smooth R&B instrumental with a warm bassline and soulful electric piano chords. Purely instrumental, no vocals.',
  Rock: 'A short high-energy rock instrumental with distorted electric guitars and a punchy drum beat. Purely instrumental, no vocals.',
};

// Requests a couple of seconds more than the ~10s ringtoneBuilder.js
// actually keeps, so its ffmpeg trim always has full-length audio to fade
// out against rather than padding silence if generation runs slightly short.
const MUSIC_LENGTH_MS = 12000;

async function generateGenreClip(genre) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error('ELEVENLABS_API_KEY not set — skipping Music API ringtone fallback for genre:', genre);
    return null;
  }
  const prompt = GENRE_PROMPTS[genre] || `A short ${genre} music instrumental, catchy and energetic. Purely instrumental, no vocals.`;
  try {
    const res = await fetchWithTimeout(
      'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128',
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt,
          music_length_ms: MUSIC_LENGTH_MS,
          model_id: 'music_v2',
          force_instrumental: true,
        }),
      },
      MUSIC_GENERATE_TIMEOUT_MS
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('ElevenLabs Music API failed:', res.status, text);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error('ElevenLabs Music API error:', err.message);
    return null;
  }
}

module.exports = { generateGenreClip };
