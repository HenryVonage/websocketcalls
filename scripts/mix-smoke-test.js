#!/usr/bin/env node
// Local smoke test for the Music Lovers "Personal DJ mix" pipeline — runs
// everything EXCEPT Spotify OAuth and WhatsApp, so it needs no tokens:
//   iTunes preview lookup → BPM/key analysis → set planning → teaser render.
//
//   node scripts/mix-smoke-test.js               # built-in 12-track sample
//   node scripts/mix-smoke-test.js my-tracks.csv  # Exportify CSV (Track Name, Artist Name(s)…)
//
// Writes the teaser to /tmp/mix-teaser.ogg (open it with QuickTime/VLC) and
// prints the planned set with transition notes. GETSONGBPM_API_KEY is
// honoured if set in the environment. Network: itunes.apple.com only.
const fs = require('fs');
const { getFeaturesForMany } = require('../lib/trackFeatures');
const { planSet, formatClock } = require('../lib/mixEngine');
const { buildTeaser } = require('../lib/mixTeaser');

const SAMPLE = [
  ['Music Sounds Better With You', 'Stardust', 'FRZ019800001'],
  ['Lady - Hear Me Tonight', 'Modjo', 'FRZ010000007'],
  ['Around the World', 'Daft Punk', 'GBDUW0600005'],
  ['Poison Lips', 'Vitalic', 'FR6V80900520'],
  ['Losing It', 'FISHER', 'AUUM71800019'],
  ['Glue', 'Bicep', 'GBCFB1700230'],
  ['Sky and Sand', 'Paul Kalkbrenner', 'DEJ360800025'],
  ['Inspector Norse', 'Todd Terje', 'NOTOD1200001'],
  ['Cola', 'CamelPhat', 'GBCEN1700236'],
  ['Hey Boy Hey Girl', 'The Chemical Brothers', 'GBAAA9900081'],
  ['Genesis', 'Justice', 'FR9W10700124'],
  ['D.A.N.C.E.', 'Justice', 'FR9W10700125'],
];

function parseCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const parse = (l) => {
    const out = [];
    let cur = '';
    let q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const head = parse(lines[0]);
  const col = (n) => head.indexOf(n);
  return lines
    .slice(1)
    .map(parse)
    .filter((r) => r.length === head.length)
    .map((r, i) => ({
      id: r[col('Track URI')] || `row${i}`,
      uri: r[col('Track URI')],
      title: r[col('Track Name')],
      artist: (r[col('Artist Name(s)')] || '').replace(/;/g, ', '),
      durationSec: Math.round((+r[col('Duration (ms)')] || 240000) / 1000),
      isrc: col('ISRC') >= 0 ? r[col('ISRC')] : null,
    }));
}

(async () => {
  const input = process.argv[2]
    ? parseCsv(process.argv[2]).slice(0, +process.env.MAX_TRACKS || 60)
    : SAMPLE.map(([title, artist, isrc], i) => ({ id: `s${i}`, title, artist, isrc, durationSec: 300, highlight: 0 }));
  console.log(`Looking up ${input.length} tracks (iTunes previews + analysis)…`);
  const t0 = Date.now();
  const analysed = await getFeaturesForMany(input, {
    budgetMs: 180000,
    onProgress: (d, n) => process.stdout.write(`\r  ${d}/${n}`),
  });
  console.log(`\n${analysed.length} analysed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const t of analysed) console.log(`  ${String(t.bpm).padStart(6)} BPM  ${(t.keyName || '?').padEnd(4)} E${t.energy}  [${t.source}]  ${t.artist} – ${t.title}`);

  const plan = planSet(analysed, { targetSec: +process.env.TARGET_SEC || 3600 });
  console.log(`\nPlanned set: ${plan.tracks.length} tracks, ${formatClock(plan.totalSec)}, median ${plan.medianBpm} BPM`);
  for (const t of plan.tracks) console.log(`  ${formatClock(t.startSec).padStart(5)}  ${t.bpm.toFixed(1)}  ${String(t.camelot).padStart(3)}  ${t.phase.padEnd(8)} ${t.artist} – ${t.title}\n         ${t.note}`);

  console.log('\nRendering teaser…');
  const t1 = Date.now();
  const ogg = await buildTeaser('smoke', plan.tracks, plan.medianBpm);
  fs.writeFileSync('/tmp/mix-teaser.ogg', ogg);
  console.log(`Teaser: ${(ogg.length / 1024).toFixed(0)} KB in ${((Date.now() - t1) / 1000).toFixed(1)} s → /tmp/mix-teaser.ogg`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
