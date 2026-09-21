// Vibe presets for the Music Lovers "Personal DJ mix" — the listener picks
// one on demo.html ("What kind of mix?") alongside a duration; each preset
// tells the pipeline three things:
//
//   bpm       — the folded-tempo band the set should live in (tracks are
//               folded half/double-time towards `centre` first, then only
//               those inside [lo, hi] are planned; see mixEngine.planSet).
//   arc       — the tempo / energy shape over the set, as fractions of the
//               set length and offsets from `centre` (tempo) or absolute
//               levels (energy). This is what makes a workout plateau feel
//               different from a house-party climb.
//   genres    — regex → weight pairs used by lib/musicLoversMix.js to rank
//               the listener's library before analysis, so a "chilled"
//               request analyses downtempo before techno, and vice versa.
//   copy      — the words used in the WhatsApp messages and playlist name.
//
// `houseparty` is the original behaviour (Sept 2026) and the default when
// the frontend sends nothing. Durations are validated separately
// (DURATIONS_MIN) — anything else falls back to 60.
const VIBES = {
  chilled: {
    label: 'Chilled',
    emoji: '🌅',
    blurb: 'sunset-terrace tempo, deep and melodic, nothing that jolts',
    bpm: { lo: 96, hi: 118, centre: 108 },
    arc: {
      bpm: [[0, -3], [0.4, 0], [0.7, +1], [1, -2]],
      energy: [[0, 0.35], [0.5, 0.5], [1, 0.4]],
    },
    genres: [
      [/downtempo|chill|lo-fi|lofi|nu jazz|trip hop|deep house|organic house|melodic house|ambient|lounge|balearic|jazz house|neo soul|bossa/i, 3],
      [/house|disco|nu disco|indie|pop|r&b|soul/i, 1],
      [/rock|hip hop|rap/i, 0],
      [/techno|hardstyle|drum and bass|dubstep|edm|big room|metal|punk|hardcore/i, -3],
    ],
  },
  houseparty: {
    label: 'House party',
    emoji: '🪩',
    blurb: 'a classic club arc — warm-up, build, peak, landing',
    bpm: { lo: 116, hi: 130, centre: 123 },
    arc: {
      bpm: [[0, -6], [0.18, -3], [0.4, 0], [0.62, +3], [0.82, +5], [0.92, +2], [1, -2]],
      energy: [[0, 0.45], [0.2, 0.55], [0.45, 0.65], [0.7, 0.8], [0.85, 0.85], [1, 0.55]],
    },
    genres: [
      [/house|techno|electro|edm|dance|disco|trance|garage|drum and bass|dubstep|breakbeat|big beat|nu disco|synth/i, 3],
      [/pop|funk|r&b|afrobeat|reggaeton|latin|hip hop|rap|trap/i, 1],
      [/rock|indie|alternative|punk|metal/i, 0],
      [/acoustic|folk|singer-songwriter|classical|orchestra|jazz|ambient|piano|soundtrack|lullaby/i, -3],
    ],
  },
  madness: {
    label: 'Madness',
    emoji: '🔥',
    blurb: 'peak time from the first bar — fast, loud, relentless',
    bpm: { lo: 126, hi: 142, centre: 133 },
    arc: {
      bpm: [[0, 0], [0.3, +2], [0.6, +5], [0.85, +6], [1, +3]],
      energy: [[0, 0.75], [0.5, 0.9], [1, 0.85]],
    },
    genres: [
      [/techno|electro|hardstyle|hard techno|hardcore|drum and bass|jungle|big room|edm|trance|rave|electroclash|acid/i, 3],
      [/house|tech house|bass|dubstep|breakbeat|big beat/i, 2],
      [/pop|hip hop|rap|trap|rock|punk|metal/i, 1],
      [/acoustic|folk|classical|jazz|ambient|downtempo|lounge|piano|soundtrack/i, -3],
    ],
  },
  workout: {
    label: 'Workout',
    emoji: '🏃',
    blurb: 'a short warm-up, then a steady high-tempo plateau, then a cool-down',
    bpm: { lo: 128, hi: 150, centre: 138 },
    arc: {
      bpm: [[0, -6], [0.1, +1], [0.85, +3], [0.9, +3], [1, -6]],
      energy: [[0, 0.55], [0.1, 0.8], [0.85, 0.85], [1, 0.5]],
    },
    genres: [
      [/edm|electro house|big room|dance pop|drum and bass|hardstyle|trap|hip hop|rap|pop punk|trance|future bass|dubstep|phonk/i, 3],
      [/house|techno|pop|rock|metal|reggaeton|afrobeat/i, 2],
      [/indie|r&b|funk|disco/i, 1],
      [/acoustic|folk|classical|jazz|ambient|downtempo|lounge|piano|soundtrack|singer-songwriter/i, -3],
    ],
  },
  motivational: {
    label: 'Motivational',
    emoji: '🚀',
    blurb: 'starts easy and keeps rising — anthems, choruses, hands up',
    bpm: { lo: 100, hi: 128, centre: 116 },
    arc: {
      bpm: [[0, -6], [0.5, 0], [1, +6]],
      energy: [[0, 0.45], [0.5, 0.65], [1, 0.9]],
    },
    genres: [
      [/pop|indie pop|dance pop|synth-pop|synthpop|anthem|arena|stadium|pop rock|alternative dance|new rave|electropop|power pop/i, 3],
      [/house|disco|nu disco|funk|soul|gospel|rock|indie/i, 2],
      [/hip hop|rap|r&b|edm|electro/i, 1],
      [/acoustic|folk|classical|ambient|jazz|lounge|downtempo|piano|sad/i, -2],
    ],
  },
};

const DEFAULT_VIBE = 'houseparty';
const DURATIONS_MIN = [30, 60, 90];
const DEFAULT_DURATION_MIN = 60;

function getVibe(key) {
  return VIBES[String(key || '').toLowerCase()] || VIBES[DEFAULT_VIBE];
}

function vibeKey(key) {
  const k = String(key || '').toLowerCase();
  return VIBES[k] ? k : DEFAULT_VIBE;
}

function normaliseDuration(min) {
  const n = Number(min);
  return DURATIONS_MIN.includes(n) ? n : DEFAULT_DURATION_MIN;
}

module.exports = { VIBES, DEFAULT_VIBE, DURATIONS_MIN, DEFAULT_DURATION_MIN, getVibe, vibeKey, normaliseDuration };
