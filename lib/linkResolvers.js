// Resolves a follow-up query to the single most relevant page on Wikipedia
// or Genius, instead of handing a listener a search-results URL to sift
// through themselves — see demo-notes.md's "Explore more" follow-ups and
// Henry's Sept 2026 request to land directly on the right page.
//
// Wikipedia's search API needs no key at all. Genius's does (a free,
// self-serve Client Access Token from genius.com/api-clients) — without
// GENIUS_ACCESS_TOKEN set, Genius links just stay search-results links,
// same as today's behavior, rather than failing outright.
//
// Both also fall back to their own search-results URL if the lookup
// itself fails for any reason (timeout, no hits, API error) — a slow or
// unavailable lookup should cost a listener one extra click, never a
// missing link.
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
    const hitUrl = json?.response?.hits?.[0]?.result?.url;
    return hitUrl || searchUrl;
  } catch (err) {
    console.error('Genius direct-page lookup failed (falling back to search link):', err.message);
    return searchUrl;
  }
}

module.exports = { resolveWikipediaUrl, resolveGeniusUrl };
