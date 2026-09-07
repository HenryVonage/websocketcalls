// Shared fetch wrapper adding a hard timeout to every outbound HTTP call.
//
// Before this, no outbound call anywhere in the codebase (Claude, Vonage,
// ElevenLabs, Spotify) had an explicit deadline — undici's default is no
// timeout at all, and the Anthropic SDK's own default is 10 minutes (see
// anthropicClient.js). In a live demo, one stalled upstream response meant
// the prospect's phone just showed nothing, with no fallback message and
// nothing in the logs to explain it (see code-review notes, Sept 2026).
// AbortSignal.timeout() is native to Node 18+ — this just adds a
// consistent default and a clearer error message than a raw AbortError.
const DEFAULT_TIMEOUT_MS = 10000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

module.exports = { fetchWithTimeout, DEFAULT_TIMEOUT_MS };
