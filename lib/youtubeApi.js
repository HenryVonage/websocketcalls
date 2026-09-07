// YouTube Data API v3 — dynamically resolves a YouTube video ID for
// whichever track the real Top Tracks catalog (see server.js's
// GET /admin/music-lovers/refresh-top-tracks-catalog and
// spotifyOAuth.js's getTopTracksBucketedByGenre) currently has picked for
// each genre. Spotify's Web API has no YouTube mapping of its own, so this
// is what keeps the "Watch on Youtube" button working automatically as
// Henry's Top Tracks (and therefore the cached pick per genre) change over
// time, instead of needing a human to look up and re-enter a video ID by
// hand after every catalog refresh.
//
// Needs YOUTUBE_API_KEY in the environment:
//   1. https://console.cloud.google.com/apis/library/youtube.googleapis.com
//      — enable "YouTube Data API v3" on a Google Cloud project (the same
//      project as any other Google API key is fine, or a fresh one).
//   2. https://console.cloud.google.com/apis/credentials — "Create
//      credentials" > "API key". No OAuth/user consent needed — this is a
//      plain server-side API key call, not a user-authorization flow.
// Free tier default quota is 10,000 units/day; search.list costs 100 units
// per call, so one full 6-genre catalog refresh costs 600 units — dozens of
// refreshes a day is still comfortably inside the default quota for a demo.
const { fetchWithTimeout } = require('./httpClient');

// Returns the video id of the first result YouTube's search returns for
// `query`, or null if the key isn't configured, the search errors, or there
// are no results. Deliberately non-throwing — a YouTube hiccup should never
// break the Top Tracks catalog refresh that calls this; it just leaves that
// one track's "Watch on Youtube" button pointing at whatever it resolved to
// last time (or the static catalog's placeholder) until the next refresh.
async function searchVideoId(query) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error('YOUTUBE_API_KEY not set — skipping YouTube lookup for:', query);
    return null;
  }
  try {
    const params = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      videoCategoryId: '10', // Music
      maxResults: '1',
      q: query,
      key: apiKey,
    });
    const res = await fetchWithTimeout(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('YouTube search failed:', res.status, JSON.stringify(json));
      return null;
    }
    return json.items?.[0]?.id?.videoId || null;
  } catch (err) {
    console.error('YouTube search error:', err.message);
    return null;
  }
}

module.exports = { searchVideoId };
