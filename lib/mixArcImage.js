// "The arc" chart for the Music Lovers "Personal DJ mix" — the tempo of
// each track across the set, coloured by phase, dot size = energy — sent
// to the listener over WhatsApp as an image message right after the set
// sheet (lib/musicLoversMix.js), served by server.js's
// /music-lovers/mix-arc/:setId.png route.
//
// Rendered server-side with @napi-rs/canvas (prebuilt native binaries,
// no system deps — installs cleanly on Render's Node runtime, same as
// ffmpeg-static does). Pure Canvas 2D, so this is also easy to tweak.
// Output is a 1200×640 PNG (~40 KB), comfortably inside WhatsApp's 5 MB
// image limit and crisp on a phone.
const { createCanvas } = require('@napi-rs/canvas');
const { formatClock } = require('./mixEngine');

const W = 1200;
const H = 640;
const PAD = { l: 90, r: 40, t: 130, b: 90 };
const PHASES = {
  'warm-up': { label: 'Warm-up', color: '#2f8f86', band: 'rgba(47,143,134,0.08)' },
  build: { label: 'Build', color: '#c98a2b', band: 'rgba(201,138,43,0.08)' },
  peak: { label: 'Peak', color: '#d9472f', band: 'rgba(217,71,47,0.08)' },
  landing: { label: 'Landing', color: '#6b5fb5', band: 'rgba(107,95,181,0.08)' },
};
const INK = '#15161a';
const MUTED = '#6b6d78';
const GRID = '#e6e4dd';
const BG = '#f4f3ef';

const cache = new Map(); // setId -> { buffer, at }
const CACHE_TTL_MS = 72 * 60 * 60 * 1000;
const CACHE_MAX = 200;

/**
 * renderArcPng(setId, plan, { title }) -> Buffer (PNG)
 * plan: lib/mixEngine.js output ({ tracks, totalSec, medianBpm }).
 */
function renderArcPng(setId, plan, { title = 'Your mix — the arc' } = {}) {
  const hit = cache.get(setId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.buffer;

  const tracks = plan.tracks || [];
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // Header
  ctx.fillStyle = INK;
  ctx.font = 'bold 40px sans-serif';
  ctx.fillText(title, PAD.l, 58);
  ctx.fillStyle = MUTED;
  ctx.font = '22px sans-serif';
  ctx.fillText(
    `${tracks.length} tracks · ${formatClock(plan.totalSec)} · colour = phase, dot size = energy`,
    PAD.l,
    94
  );

  if (!tracks.length) return finish(canvas, setId);

  const totalSec = Math.max(1, plan.totalSec);
  const bpms = tracks.map((t) => t.bpm);
  const bMin = Math.floor((Math.min(...bpms) - 2) / 4) * 4;
  const bMax = Math.ceil((Math.max(...bpms) + 2) / 4) * 4;
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const x = (sec) => PAD.l + (sec / totalSec) * plotW;
  const y = (bpm) => PAD.t + (1 - (bpm - bMin) / (bMax - bMin)) * plotH;

  // Phase bands
  let curPhase = null;
  let bandStart = 0;
  const bands = [];
  tracks.forEach((t) => {
    if (t.phase !== curPhase) {
      if (curPhase) bands.push([curPhase, bandStart, t.startSec]);
      curPhase = t.phase;
      bandStart = t.startSec;
    }
  });
  if (curPhase) bands.push([curPhase, bandStart, totalSec]);
  for (const [phase, s, e] of bands) {
    ctx.fillStyle = (PHASES[phase] || PHASES.peak).band;
    ctx.fillRect(x(s), PAD.t, x(e) - x(s), plotH);
  }

  // Grid + axis labels
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.fillStyle = MUTED;
  ctx.font = '18px monospace';
  ctx.textAlign = 'right';
  for (let b = bMin; b <= bMax; b += 4) {
    ctx.beginPath();
    ctx.moveTo(PAD.l, y(b));
    ctx.lineTo(W - PAD.r, y(b));
    ctx.stroke();
    ctx.fillText(String(b), PAD.l - 12, y(b) + 6);
  }
  ctx.textAlign = 'center';
  const tickEvery = totalSec > 5400 ? 1800 : 600; // 30 min or 10 min
  for (let s = 0; s <= totalSec + 1; s += tickEvery) ctx.fillText(formatClock(s), x(s), H - PAD.b + 30);

  // Step line
  ctx.strokeStyle = '#8f919c';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  tracks.forEach((t, i) => {
    const x0 = x(t.startSec);
    // A track "ends" where the next one starts (the planner overlaps them
    // for the blend), or at the set's end for the last one.
    const x1 = x(i < tracks.length - 1 ? tracks[i + 1].startSec : totalSec);
    const yy = y(t.bpm);
    if (i === 0) ctx.moveTo(x0, yy);
    else ctx.lineTo(x0, yy);
    ctx.lineTo(x1, yy);
  });
  ctx.stroke();

  // Dots
  tracks.forEach((t, i) => {
    const end = i < tracks.length - 1 ? tracks[i + 1].startSec : totalSec;
    const cx = x((t.startSec + end) / 2);
    const r = 7 + (t.energy == null ? 0.6 : t.energy) * 9;
    ctx.fillStyle = (PHASES[t.phase] || PHASES.peak).color;
    ctx.beginPath();
    ctx.arc(cx, y(t.bpm), r, 0, Math.PI * 2);
    ctx.fill();
  });

  // Legend
  ctx.font = '20px sans-serif';
  ctx.textAlign = 'left';
  let lx = PAD.l;
  const ly = H - 24;
  for (const phase of bands.map((b) => b[0]).filter((p, i, a) => a.indexOf(p) === i)) {
    const { label, color } = PHASES[phase] || PHASES.peak;
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly - 14, 16, 16);
    ctx.fillStyle = MUTED;
    ctx.fillText(label, lx + 24, ly);
    lx += 24 + ctx.measureText(label).width + 36;
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = MUTED;
  ctx.fillText('Vonage Music Lovers', W - PAD.r, ly);

  return finish(canvas, setId);
}

function finish(canvas, setId) {
  const buffer = canvas.toBuffer('image/png');
  cache.set(setId, { buffer, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return buffer;
}

module.exports = { renderArcPng };
