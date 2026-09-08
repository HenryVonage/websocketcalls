// Resolves a follow-up query to the single most relevant page on
// Wikipedia, Genius, or (for concerts) Ticketmaster, instead of handing a
// listener a search-results URL to sift through themselves — see
// demo-notes.md's "Explore more" follow-ups and Henry's Sept 2026 request
// to land directly on the right page.
//
// Wikipedia's search API needs no key at all. Genius's and Ticketmaster's
// do (both free, self-serve — genius.com/api-clients and
// developer-account.ticketmaster.com respectively) — without the
// relevant env var set, that service's link just stays a search-results
// link, same as before this feature existed, rather than failing
// outright.
//
// All three also fall back to their own search-results URL if the lookup
// itself fails for any reason (timeout, no hits, API error) — a slow or
// unavailable lookup should cost a listener one extra click, never a
// missing link.
//
// Songkick was the original concerts source (see git history) but their
// API has stopped accepting new key applications altogether as of Sept
// 2026 ("we are unable to process new applications for API keys" —
// confirmed on their own application page), so concerts moved to
// Ticketmaster's Discovery API instead — also self-serve, and Henry
// already had an approved developer app.
const { fetchWithTimeout } = require('./httpClient');

async function resolveWikipediaUrl(query) {
  const searchUrl = `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`;
  try {
    const apiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1`;
    const res = await fetchWithTimeout(apiUrl);
    if (!res.ok) return searchUrl;
    const json = await res.json();
    const title = json?.query?.search?.[0]?.title;
    if (!title) return searchUrl;
    return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  } catch (err) {
    console.error('Wikipedia direct-page lookup failed (falling back to search link):', err.message);
    return searchUrl;
  }
}

// Genius's own translation/romanization pages ("Genius Traducciones al
// Español", "Genius Türkçe Çeviri", "Genius Brasil Traduções", "Genius
// Romanizations", etc.) are indexed as their own separate hits, credited
// to a "Genius <language>" house account rather than the real artist —
// and for a popular song they can easily out-rank the original in
// relevance (live report, Sept 2026: a Spanish translation page came back
// for an English song). Every one of those house accounts has "genius"
// in its own primary_artist name, which a real artist's name never does,
// so skipping any hit whose primary_artist name contains it reliably
// finds the original page instead of taking hits[0] blindly.
function isGeniusTranslationHit(hit) {
  const artistName = hit?.result?.primary_artist?.name || '';
  return artistName.toLowerCase().includes('genius');
}

async function resolveGeniusUrl(query) {
  const searchUrl = `https://genius.com/search?q=${encodeURIComponent(query)}`;
  const token = process.env.GENIUS_ACCESS_TOKEN;
  if (!token) return searchUrl; // no token configured yet — same behavior as before

  try {
    const res = await fetchWithTimeout(`https://api.genius.com/search?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return searchUrl;
    const json = await res.json();
    const hits = json?.response?.hits || [];
    const originalHit = hits.find((hit) => !isGeniusTranslationHit(hit)) || hits[0];
    return originalHit?.result?.url || searchUrl;
  } catch (err) {
    console.error('Genius direct-page lookup failed (falling back to search link):', err.message);
    return searchUrl;
  }
}

// Ticketmaster's Discovery API returns upcoming events sorted by date, each
// with its own direct ticketmaster.com page (the "url" field) — links to
// the soonest upcoming show for this artist, which is more useful to a
// listener than an artist-level page would be. Falls back to
// Ticketmaster's own site search (still a real, working page, just not a
// specific event) when there's no upcoming event, no token, or the lookup
// fails.
async function resolveConcertsUrl(query) {
  const searchUrl = `https://www.ticketmaster.com/search?q=${encodeURIComponent(query)}`;
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) return searchUrl;

  try {
    const apiUrl = `https://app.ticketmaster.com/discovery/v2/events.json?keyword=${encodeURIComponent(query)}&sort=date,asc&size=1&apikey=${apiKey}`;
    const res = await fetchWithTimeout(apiUrl);
    if (!res.ok) return searchUrl;
    const json = await res.json();
    const eventUrl = json?._embedded?.events?.[0]?.url;
    return eventUrl || searchUrl;
  } catch (err) {
    console.error('Ticketmaster direct-page lookup failed (falling back to search link):', err.message);
    return searchUrl;
  }
}

// Same Ticketmaster Discovery API as resolveConcertsUrl above, but returns
// the event's own venue name and date alongside the direct event URL — for
// the henry_ticketingconcert WhatsApp template (Sept 2026), whose body
// names the venue and date as their own {{ }} variables rather than making
// a listener open the link just to find out where/when. A template send
// needs a real value for every variable — there's no "link to a search
// page instead" fallback the way resolveConcertsUrl has for a plain-text
// message — so this returns null (not a partial result) on any miss: no
// API key configured, no upcoming event for this artist, a missing
// venue/date on the event Ticketmaster did return, or the request failing
// outright. The caller decides what null means (today: fall back to
// resolveConcertsUrl's plain-text link instead of sending the template).
async function resolveConcertDetails(query) {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) return null;

  try {
    const apiUrl = `https://app.ticketmaster.com/discovery/v2/events.json?keyword=${encodeURIComponent(query)}&sort=date,asc&size=1&apikey=${apiKey}`;
    const res = await fetchWithTimeout(apiUrl);
    if (!res.ok) return null;
    const json = await res.json();
    const event = json?._embedded?.events?.[0];
    const url = event?.url;
    const venue = event?._embedded?.venues?.[0]?.name;
    const localDate = event?.dates?.start?.localDate; // e.g. "2026-12-05", no time component
    if (!url || !venue || !localDate) return null;

    // Formatted in UTC deliberately — localDate has no time/offset of its
    // own (it's already the calendar date in the venue's own timezone), so
    // parsing it as UTC midnight and formatting in UTC is the only way to
    // avoid the server's own timezone shifting it to the day before or
    // after depending on where this happens to be running.
    const date = new Date(`${localDate}T00:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    return { venue, date, url };
  } catch (err) {
    console.error('Ticketmaster concert-details lookup failed:', err.message);
    return null;
  }
}

module.exports = { resolveWikipediaUrl, resolveGeniusUrl, resolveConcertsUrl, resolveConcertDetails };
