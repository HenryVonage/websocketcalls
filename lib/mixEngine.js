// Harmonic set planner for the Music Lovers "Personal DJ mix" feature —
// turns a bag of analysed tracks ({ bpm, key, mode, energy, durationSec… })
// into an ordered set that a DJ could actually mix: adjacent tracks are
// compatible on the Camelot wheel, tempo moves by small steps, and the
// energy follows a club-style arc (warm-up → build → peak → landing).
//
// Pure and synchronous — no I/O, no Spotify — so it's trivially unit
// testable (see test/mixEngine.test.js) and the same planner can serve the
// WhatsApp flow (lib/musicLoversMix.js), an RCS variant, or a CLI.
//
// Algorithm: beam search over track sequences. Each step's cost is
//   3 × camelotDistance  (0 same key … 6 clash; clashes are pruned outright)
// + tempo-jump penalty   (free within ±1.5 %, quadratic beyond, hard cap 3.5 %)
// + |bpm − arcBpm(t)|    (the arc is relative to the pool's own median so a
//                         90-BPM hip-hop library gets a 90-BPM arc, not a
//                         house one)
// + |energy − arcEnergy(t)|
// − highlight bonus      (caller-supplied, e.g. the listener's top tracks)
// with a "no same primary artist within 6 tracks" rule. Beam width 600 keeps
// a 150-track pool under ~1 s on Node.
//
// Half/double-time: hip-hop at 90 and house at 128 don't beat-match, but
// 90 vs 180 and 64 vs 128 do — tempos are folded into one octave band
// around the pool median before planning (foldTempo), and the fold factor
// is reported per track so the teaser renderer can stretch correctly.

const MAJ = { 0: '8B', 1: '3B', 2: '10B', 3: '5B', 4: '12B', 5: '7B', 6: '2B', 7: '9B', 8: '4B', 9: '11B', 10: '6B', 11: '1B' };
const MIN = { 0: '5A', 1: '12A', 2: '7A', 3: '2A', 4: '9A', 5: '4A', 6: '11A', 7: '6A', 8: '1A', 9: '8A', 10: '3A', 11: '10A' };
const PITCH_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function camelot(key, mode) {
  if (key == null || mode == null) return null;
  return (mode === 1 ? MAJ : MIN)[key];
}

function keyName(key, mode) {
  if (key == null || mode == null) return null;
  return PITCH_NAMES[key] + (mode === 1 ? '' : 'm');
}

// 0 = same key, 0.5 = relative major/minor, 1 = neighbour, 2.5 = two steps
// or diagonal (usable as an "energy" mix when cut rather than blended),
// 6 = clash. Unknown key on either side = 2 (mild penalty, never a prune).
function camelotDistance(a, b) {
  if (!a || !b) return 2;
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  const la = a.slice(-1);
  const lb = b.slice(-1);
  const d = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  if (d === 0) return la === lb ? 0 : 0.5;
  if (d === 1 && la === lb) return 1;
  if (d === 2 && la === lb) return 2.5;
  if (d === 1) return 2.5;
  return 6;
}

// Folds bpm into [centre/√2, centre·√2) by halving/doubling; returns the
// folded bpm and the factor applied (0.5, 1 or 2).
function foldTempo(bpm, centre) {
  let factor = 1;
  let b = bpm;
  const lo = centre / Math.SQRT2;
  const hi = centre * Math.SQRT2;
  while (b < lo) {
    b *= 2;
    factor *= 2;
  }
  while (b >= hi) {
    b /= 2;
    factor /= 2;
  }
  return { bpm: b, factor };
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)));
  return s[i];
}

function interp(points, t) {
  for (let i = 0; i < points.length - 1; i++) {
    const [t0, v0] = points[i];
    const [t1, v1] = points[i + 1];
    if (t <= t1) return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
  }
  return points[points.length - 1][1];
}

// Arc shapes as fractions of total length. Without a vibe: the classic
// club arc relative to the pool median, clamped into the pool's own
// 10th–90th percentile so a narrow pool (all 124–126) doesn't get asked
// for tempos it can't supply. With a vibe (lib/mixVibes.js): the preset's
// own tempo offsets around its centre and absolute energy levels — a
// workout plateau, a chilled flat line, a motivational climb.
function buildArc(totalSec, poolBpms, poolEnergies, vibe) {
  const med = vibe ? vibe.bpm.centre : median(poolBpms);
  const lo = vibe ? vibe.bpm.lo : percentile(poolBpms, 0.1);
  const hi = vibe ? vibe.bpm.hi : percentile(poolBpms, 0.9);
  const clamp = (b) => Math.min(hi, Math.max(lo, b));
  const bpmShape = vibe ? vibe.arc.bpm : [[0, -6], [0.18, -3], [0.4, 0], [0.62, 3], [0.82, 5], [0.92, 2], [1, -2]];
  const bpmPts = bpmShape.map(([f, off]) => [f * totalSec, clamp(med + off)]);
  let energyPts;
  if (vibe) {
    energyPts = vibe.arc.energy.map(([f, e]) => [f * totalSec, e]);
  } else {
    const eMed = median(poolEnergies) ?? 0.6;
    const eLo = Math.max(0, eMed - 0.25);
    const eHi = Math.min(1, eMed + 0.2);
    energyPts = [
      [0, eLo],
      [0.2, eMed - 0.1],
      [0.45, eMed],
      [0.7, eHi],
      [0.85, eHi],
      [1, eMed - 0.15],
    ].map(([f, e]) => [f * totalSec, e]);
  }
  return {
    bpmAt: (t) => interp(bpmPts, t),
    energyAt: (t) => interp(energyPts, t),
    medianBpm: vibe ? median(poolBpms) : med,
  };
}

// How much of a track is overlapped by the next one: a long club track
// gets a ~60 s blend, a 2:40 radio edit ~30 s.
function overlapSec(durationSec) {
  return Math.min(60, durationSec * 0.2);
}

function phaseFor(fraction) {
  if (fraction < 0.2) return 'warm-up';
  if (fraction < 0.45) return 'build';
  if (fraction < 0.85) return 'peak';
  return 'landing';
}

// Human note for the transition INTO `cur` from `prev`, written the way a
// DJ would jot it on a set sheet. Kept short: it's shown on a phone.
function transitionNote(prev, cur) {
  if (!prev) return 'Opener — let the intro breathe.';
  const d = camelotDistance(prev.camelot, cur.camelot);
  const bpmDelta = ((cur.bpm - prev.bpm) / prev.bpm) * 100;
  const tempo = Math.abs(bpmDelta) < 0.5 ? 'same tempo' : `${bpmDelta > 0 ? '+' : ''}${bpmDelta.toFixed(1)} %`;
  const keys = prev.keyName && cur.keyName ? `${prev.keyName} → ${cur.keyName}` : 'key unknown';
  let how;
  if (d === 0) how = 'same key — long blend, swap the bass on the drop';
  else if (d === 0.5) how = 'relative key — long blend works';
  else if (d === 1) how = 'neighbouring key — 32-bar blend';
  else if (d === 2) how = 'key unclear — use a short EQ swap';
  else if (d === 2.5) how = 'two steps on the wheel — cut on the drop rather than blend';
  else how = 'keys clash — hard cut on the 1, or drop a breakdown between them';
  return `${keys}, ${tempo}. ${how}.`;
}

/**
 * planSet(tracks, options) -> { tracks: [...ordered], totalSec, medianBpm }
 *
 * tracks: [{ id, title, artist, durationSec, bpm, key, mode, energy, highlight? }]
 *   key: 0..11 or null, mode: 1 major / 0 minor / null, energy 0..1 or null.
 * options.targetSec  — set length (default 3600).
 * options.vibe       — a lib/mixVibes.js preset (tempo band + arc shape); omit
 *                      for the pool-relative club arc.
 * options.beamWidth  — default 600.
 * options.seed       — deterministic tie-breaking (default 1).
 */
function planSet(tracks, options = {}) {
  const targetSec = options.targetSec || 3600;
  const strict = planOnce(tracks, { ...options, relaxed: false });
  if (strict.totalSec >= targetSec * 0.8) return strict;
  // Small or awkward pool (few tracks, keys that don't chain): rather than
  // hand back a 25-minute "hour", re-plan with the harmonic rule as a
  // heavy penalty instead of a hard prune and a wider tempo window, and
  // keep whichever plan gets closer to the target length.
  const relaxed = planOnce(tracks, { ...options, relaxed: true });
  return relaxed.totalSec > strict.totalSec ? { ...relaxed, relaxed: true } : strict;
}

function planOnce(tracks, options) {
  const targetSec = options.targetSec || 3600;
  const beamWidth = options.beamWidth || 600;
  const relaxed = Boolean(options.relaxed);
  let rand = mulberry32(options.seed || 1);

  const vibe = options.vibe || null;
  let usable = tracks.filter((t) => t && t.bpm > 0 && t.durationSec >= 90);
  if (usable.length === 0) return { tracks: [], totalSec: 0, medianBpm: null };

  // Tempo centre: the vibe's, or the pool's own median. With a vibe, only
  // tracks whose folded tempo sits inside the vibe's band are planned —
  // widening the band in 4-BPM steps if that leaves too few to fill the
  // set, and giving up on the filter entirely below MIN_IN_BAND.
  const centre = vibe ? vibe.bpm.centre : median(usable.map((t) => t.bpm));
  if (vibe) {
    const MIN_IN_BAND = 12;
    let widen = 0;
    let inBand = [];
    for (; widen <= 24; widen += 4) {
      inBand = usable.filter((t) => {
        const b = foldTempo(t.bpm, centre).bpm;
        return b >= vibe.bpm.lo - widen && b <= vibe.bpm.hi + widen;
      });
      if (inBand.length >= MIN_IN_BAND) break;
    }
    if (inBand.length >= Math.min(MIN_IN_BAND, usable.length)) usable = inBand;
  }
  const pool = usable.map((t, i) => {
    const folded = foldTempo(t.bpm, centre);
    return {
      ...t,
      idx: i,
      rawBpm: t.bpm,
      bpm: folded.bpm,
      tempoFactor: folded.factor,
      camelot: camelot(t.key, t.mode),
      keyName: keyName(t.key, t.mode),
      energy: t.energy == null ? null : Math.max(0, Math.min(1, t.energy)),
      primaryArtist: String(t.artist || '').split(/[,;&]/)[0].trim().toLowerCase(),
    };
  });
  const arc = buildArc(targetSec, pool.map((p) => p.bpm), pool.filter((p) => p.energy != null).map((p) => p.energy), vibe);

  function stepCost(prev, cur, t) {
    let c = 0;
    if (prev) {
      const cd = camelotDistance(prev.camelot, cur.camelot);
      if (cd >= 6 && !relaxed) return Infinity;
      c += 3 * cd + (cd >= 2.5 ? 6 : 0) + (cd >= 6 ? 20 : 0);
      const bd = (Math.abs(cur.bpm - prev.bpm) / prev.bpm) * 100;
      if (bd > (relaxed ? 6 : 3.5)) return Infinity;
      if (bd > 1.5) c += (2 * (bd - 1.5)) ** 2;
    }
    c += 1.2 * Math.abs(cur.bpm - arc.bpmAt(t));
    if (cur.energy != null) c += 12 * Math.abs(cur.energy - arc.energyAt(t));
    c -= 2 * (cur.highlight || 0);
    if (cur.durationSec < 150) c += 1; // radio edits are hard to mix out of
    return c;
  }

  // state: { cost, t, used:Set, seq:[], recent:[] }
  let states = [{ cost: 0, t: 0, used: new Set(), seq: [], recent: [] }];
  let best = null;
  const maxSteps = Math.ceil(targetSec / 90) + 2;
  for (let step = 0; step < maxSteps; step++) {
    const next = [];
    for (const s of states) {
      if (s.t >= targetSec - 120) {
        if (!best || s.cost < best.cost) best = s;
        continue;
      }
      const prev = s.seq.length ? pool[s.seq[s.seq.length - 1]] : null;
      for (const cur of pool) {
        if (s.used.has(cur.idx)) continue;
        if (cur.primaryArtist && s.recent.slice(-6).includes(cur.primaryArtist)) continue;
        const sc = stepCost(prev, cur, s.t);
        if (!Number.isFinite(sc)) continue;
        const nt = s.t + cur.durationSec - overlapSec(cur.durationSec);
        if (nt > targetSec + 240) continue;
        const used = new Set(s.used);
        used.add(cur.idx);
        next.push({
          cost: s.cost + sc + rand() * 0.01,
          t: nt,
          used,
          seq: [...s.seq, cur.idx],
          recent: [...s.recent, cur.primaryArtist],
        });
      }
    }
    if (!next.length) break;
    next.sort((a, b) => a.cost / Math.max(a.t, 1) - b.cost / Math.max(b.t, 1));
    states = next.slice(0, beamWidth);
  }
  if (!best) best = states.reduce((a, b) => (a.cost <= b.cost ? a : b), states[0]);

  let t = 0;
  const ordered = best.seq.map((idx, i) => {
    const p = pool[idx];
    const prev = i ? pool[best.seq[i - 1]] : null;
    const entry = {
      id: p.id,
      title: p.title,
      artist: p.artist,
      uri: p.uri,
      url: p.url,
      isrc: p.isrc,
      durationSec: p.durationSec,
      bpm: Math.round(p.bpm * 10) / 10,
      rawBpm: Math.round(p.rawBpm * 10) / 10,
      tempoFactor: p.tempoFactor,
      key: p.key,
      mode: p.mode,
      keyName: p.keyName,
      camelot: p.camelot,
      energy: p.energy,
      startSec: Math.round(t),
      phase: phaseFor(t / targetSec),
      camelotDistance: prev ? camelotDistance(prev.camelot, p.camelot) : 0,
      bpmDeltaPct: prev ? Math.round(((p.bpm - prev.bpm) / prev.bpm) * 1000) / 10 : 0,
      note: transitionNote(prev, p),
      previewUrl: p.previewUrl,
      beatOffsetSec: p.beatOffsetSec,
    };
    t += p.durationSec - (i < best.seq.length - 1 ? overlapSec(p.durationSec) : 0);
    return entry;
  });
  return { tracks: ordered, totalSec: Math.round(t), medianBpm: Math.round(arc.medianBpm * 10) / 10 };
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function formatClock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

module.exports = { planSet, camelot, camelotDistance, foldTempo, keyName, formatClock, transitionNote };
