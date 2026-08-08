// Fetches a short-lived signed websocket URL for starting a conversation
// with a specific ElevenLabs agent. Required because the agent is private
// (workspace API key auth) rather than public.
// Docs: GET /v1/convai/conversation/get-signed-url
async function getSignedUrl(agentId) {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
  const res = await fetch(url, {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ElevenLabs get-signed-url failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  return json.signed_url;
}

module.exports = { getSignedUrl };
