// Public "is the host live on Twitch?" check for the website.
// Asks Twitch Helix with an app token (secrets TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET),
// caches the answer for 60 s, and returns only public facts: live or not and when it started.
// Channels come from LIVE_LOGINS (comma list), default ceciliaplayspoker.

const LOGINS = (Deno.env.get("LIVE_LOGINS") ?? "ceciliaplayspoker")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const CACHE_MS = 60_000;

let token: { value: string; expires: number } | null = null;
let cached: { at: number; body: string } | null = null;

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, max-age=60",
};

async function appToken(id: string, secret: string): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const r = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }),
  });
  if (!r.ok) throw new Error(`token ${r.status}`);
  const j = await r.json();
  token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return token.value;
}

async function check(): Promise<string> {
  const id = Deno.env.get("TWITCH_CLIENT_ID");
  const secret = Deno.env.get("TWITCH_CLIENT_SECRET");
  const channels: Record<string, { live: boolean; started_at: string | null }> = {};
  for (const l of LOGINS) channels[l] = { live: false, started_at: null };
  if (!id || !secret) return JSON.stringify({ ok: false, reason: "not configured", channels });

  const q = LOGINS.map((l) => "user_login=" + encodeURIComponent(l)).join("&");
  let r = await fetch("https://api.twitch.tv/helix/streams?" + q, {
    headers: { "Client-Id": id, Authorization: "Bearer " + await appToken(id, secret) },
  });
  if (r.status === 401) { // token revoked early: get a fresh one once
    token = null;
    r = await fetch("https://api.twitch.tv/helix/streams?" + q, {
      headers: { "Client-Id": id, Authorization: "Bearer " + await appToken(id, secret) },
    });
  }
  if (!r.ok) throw new Error(`streams ${r.status}`);
  const j = await r.json();
  for (const s of j.data ?? []) {
    const l = String(s.user_login).toLowerCase();
    if (l in channels && s.type === "live") channels[l] = { live: true, started_at: s.started_at };
  }
  return JSON.stringify({ ok: true, checked_at: new Date().toISOString(), channels });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET") return new Response("{}", { status: 405, headers });
  try {
    if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), body: await check() };
    return new Response(cached.body, { headers });
  } catch (e) {
    console.error(e);
    const channels = Object.fromEntries(LOGINS.map((l) => [l, { live: false, started_at: null }]));
    return new Response(JSON.stringify({ ok: false, reason: "twitch error", channels }), { status: 502, headers });
  }
});
