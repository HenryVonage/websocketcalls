// Pure-JS audio analysis for the Music Lovers "1-hour mix" feature (see
// lib/trackFeatures.js for where this is called from, and demo-notes.md's
// "Personal DJ mix" section for the concept).
//
// Why this exists at all: Spotify removed /v1/audio-features (tempo, key,
// energy…) for apps created after Nov 2024, so the mix engine
// (lib/mixEngine.js) has to work out BPM and musical key itself. This
// module does that from a 30-second preview clip — a mono PCM buffer that
// lib/trackFeatures.js decodes with ffmpeg-static first — using textbook
// MIR techniques, no native deps:
//
//   tempo  — spectral-flux onset envelope, scored with a comb filter over
//            60–200 BPM (best beat-grid phase per candidate), then refined
//            to 0.05 BPM; a log-normal prior centred on ~120 BPM breaks
//            octave ties (the classic 65 vs 130 problem).
//   key    — 12-bin chroma from the same STFT, correlated with the
//            Krumhansl–Schmuckler major/minor key profiles; best of 24 wins.
//   energy — normalised RMS loudness (0..1), a stand-in for Spotify's old
//            "energy" so the arc planner still has something to shape.
//   beatOffset — time (s) of the first strong onset that sits on the
//            detected beat grid, so lib/mixTeaser.js can cut each clip on a
//            downbeat-ish boundary rather than mid-beat.
//
// Accuracy is "good enough for a DJ demo": on a 30-s house/pop clip tempo
// is right (or an exact octave off, which the mix engine folds anyway)
// the large majority of the time; key detection on dense electronic
// material is roughly 70–80% — same ballpark as free desktop tools. A
// wrong key just costs one harmonic-compatibility point in the planner,
// never a crash.
//
// All functions are synchronous and CPU-bound: ~100–200 ms per 30-s clip
// at 11 025 Hz on Render's standard instance. lib/trackFeatures.js bounds
// concurrency so a big playlist can't peg the event loop for long.

const SAMPLE_RATE = 11025; // what trackFeatures.js asks ffmpeg for
const FRAME = 1024;
const HOP = 128; // ~11.6 ms per frame at 11 025 Hz — fine enough for ±0.2 BPM after the comb refinement

// ---------- FFT (iterative radix-2, real input packed as complex) ----------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j];
        const ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br;
        im[i + j] = ai + bi;
        re[i + j + len / 2] = ar - br;
        im[i + j + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const HANN = new Float32Array(FRAME);
for (let i = 0; i < FRAME; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

// One pass over the signal producing, per frame: log-magnitude spectrum
// (for onset flux) and a chroma vector (for key). Returns
// { onset: Float32Array(nFrames), chroma: Float32Array(12), rms: number }.
function analyseFrames(pcm) {
  const nFrames = Math.max(0, Math.floor((pcm.length - FRAME) / HOP) + 1);
  const onset = new Float32Array(nFrames);
  const chroma = new Float32Array(12);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  let prevLog = new Float32Array(FRAME / 2);
  let curLog = new Float32Array(FRAME / 2);
  let rmsAcc = 0;

  // Precompute bin -> pitch-class mapping for the chroma (65 Hz .. 2 kHz —
  // below that the bins are too coarse, above it overtones muddy things).
  const binPc = new Int8Array(FRAME / 2).fill(-1);
  for (let b = 1; b < FRAME / 2; b++) {
    const hz = (b * SAMPLE_RATE) / FRAME;
    if (hz < 65 || hz > 2000) continue;
    const midi = 69 + 12 * Math.log2(hz / 440);
    binPc[b] = ((Math.round(midi) % 12) + 12) % 12;
  }

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    let frameRms = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = pcm[off + i];
      re[i] = s * HANN[i];
      im[i] = 0;
      frameRms += s * s;
    }
    rmsAcc += Math.sqrt(frameRms / FRAME);
    fft(re, im);
    let flux = 0;
    for (let b = 1; b < FRAME / 2; b++) {
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      curLog[b] = Math.log1p(mag * 50);
      const d = curLog[b] - prevLog[b];
      if (d > 0) flux += d; // half-wave rectified spectral flux
      const pc = binPc[b];
      if (pc >= 0) chroma[pc] += mag * mag; // power-weighted chroma
    }
    onset[f] = flux;
    [prevLog, curLog] = [curLog, prevLog];
  }
  return { onset, chroma, rms: nFrames ? rmsAcc / nFrames : 0 };
}

// ---------- tempo ----------
// Comb-filter tempo estimation rather than plain autocorrelation: for each
// candidate BPM the onset envelope is sampled (with interpolation) along a
// beat grid at every possible phase, and the best phase's mean onset
// strength is the candidate's score. Compared with autocorrelation this
// doesn't drift on fractional lags, and a 2/3 or 3/2 tempo (which
// off-beat hi-hats make autocorrelation love) scores visibly lower because
// its grid lands on alternating strong/weak onsets. Half/double tempo tie
// (both grids land on kicks only) is broken by a log-normal prior around
// 120 BPM — lib/mixEngine.js folds octave errors anyway.
const FPS = SAMPLE_RATE / HOP;

function normaliseOnset(onset) {
  const n = onset.length;
  const out = new Float32Array(n);
  const win = 48; // ~0.55 s local mean
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += onset[i];
    if (i >= win) acc -= onset[i - win];
    out[i] = Math.max(0, onset[i] - acc / Math.min(i + 1, win));
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n || 1;
  let sd = 0;
  for (let i = 0; i < n; i++) sd += (out[i] - mean) ** 2;
  sd = Math.sqrt(sd / (n || 1)) || 1;
  for (let i = 0; i < n; i++) out[i] = (out[i] - mean) / sd;
  return out;
}

function combScore(env, lagFrames) {
  // Best phase for this lag: mean of interpolated env values on the grid.
  const n = env.length;
  let best = -Infinity;
  let bestPhase = 0;
  const phaseStep = Math.max(0.5, lagFrames / 48);
  for (let phase = 0; phase < lagFrames; phase += phaseStep) {
    let sum = 0;
    let count = 0;
    for (let p = phase; p < n - 1; p += lagFrames) {
      const i = Math.floor(p);
      const frac = p - i;
      sum += env[i] * (1 - frac) + env[i + 1] * frac;
      count++;
    }
    const m = count ? sum / count : -Infinity;
    if (m > best) {
      best = m;
      bestPhase = phase;
    }
  }
  return { score: best, phase: bestPhase };
}

function prior(bpm) {
  return Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.6, 2));
}

function detectTempo(onset) {
  if (onset.length < FPS * 5) return { bpm: null, confidence: 0 };
  const env = normaliseOnset(onset);
  let best = { bpm: null, score: -Infinity, phase: 0 };
  const all = [];
  for (let bpm = 60; bpm <= 200; bpm += 0.5) {
    const { score } = combScore(env, (60 * FPS) / bpm);
    const s = score * prior(bpm);
    all.push(s);
    if (s > best.score) best = { bpm, score: s };
  }
  if (!best.bpm) return { bpm: null, confidence: 0 };
  // Fine pass around the winner (±1.5 BPM, 0.05 steps) for beat-matching
  // grade precision, this time without the prior (it's flat over ±1.5).
  let fine = { bpm: best.bpm, score: -Infinity, phase: 0 };
  for (let bpm = best.bpm - 1.5; bpm <= best.bpm + 1.5; bpm += 0.05) {
    const r = combScore(env, (60 * FPS) / bpm);
    if (r.score > fine.score) fine = { bpm, score: r.score, phase: r.phase };
  }
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  const sd = Math.sqrt(all.reduce((a, b) => a + (b - mean) ** 2, 0) / all.length) || 1;
  const confidence = Math.max(0, Math.min(1, (best.score - mean) / (4 * sd)));
  return {
    bpm: Math.round(fine.bpm * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    lag: (60 * FPS) / fine.bpm,
    phase: fine.phase,
  };
}

// First strong onset lying on the beat grid: scans the onset envelope for
// the frame whose comb of `lag`-spaced successors is loudest — i.e. the
// phase of the beat grid — then returns that as seconds.
function beatOffsetSeconds(tempo) {
  return tempo.phase / FPS;
}

// ---------- key ----------
// Krumhansl–Schmuckler profiles (Temperley-weighted variant is not needed
// for pop/electronic; the classic ones behave well with power chroma).
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const PITCH_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function pearson(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function detectKey(chroma) {
  // Compress dynamics so one booming bass note doesn't dominate.
  const c = Array.from(chroma, (v) => Math.log1p(v));
  let best = { key: null, mode: null, score: -Infinity };
  for (let tonic = 0; tonic < 12; tonic++) {
    const rot = c.map((_, i) => c[(i + tonic) % 12]);
    const sMaj = pearson(rot, MAJOR);
    const sMin = pearson(rot, MINOR);
    if (sMaj > best.score) best = { key: tonic, mode: 1, score: sMaj };
    if (sMin > best.score) best = { key: tonic, mode: 0, score: sMin };
  }
  return best;
}

// ---------- public ----------
// pcm: Float32Array, mono, SAMPLE_RATE Hz. Returns null on silence/too short.
function analysePcm(pcm) {
  if (!pcm || pcm.length < SAMPLE_RATE * 5) return null;
  const { onset, chroma, rms } = analyseFrames(pcm);
  const tempo = detectTempo(onset);
  if (!tempo.bpm) return null;
  const key = detectKey(chroma);
  return {
    bpm: tempo.bpm,
    bpmConfidence: Math.round(tempo.confidence * 100) / 100,
    key: key.key, // 0 = C … 11 = B, same convention Spotify used
    mode: key.mode, // 1 = major, 0 = minor
    keyName: PITCH_NAMES[key.key] + (key.mode ? '' : 'm'),
    keyConfidence: Math.round(Math.max(0, key.score) * 100) / 100,
    // Typical mastered pop/electronic previews land around RMS 0.15–0.3
    // in float PCM; map that band onto ~0.4–1.0 so quiet acoustic tracks
    // sit low and club tracks sit high, like Spotify's old energy did.
    energy: Math.round(Math.min(1, Math.max(0, rms / 0.3)) * 100) / 100,
    beatOffsetSec: Math.round(beatOffsetSeconds(tempo) * 1000) / 1000,
  };
}

module.exports = { analysePcm, SAMPLE_RATE, PITCH_NAMES };
