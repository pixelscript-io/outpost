// Cloudflare Worker that serves the DayZ server list to the Outpost app.
//
// It exists to keep the Steam Web API key off the player's computer. The key lives in the Worker's
// secrets, the Worker asks Steam for the list, caches it, and the app downloads it from here.
//
//   GET /v1/servers   {"fetchedAt": <unix seconds>, "parts": [{"name": "...", "data": <Steam's JSON>}, ...]}
//   GET /health       "ok"
//
// Only servers that have players are served. Measured against the real API: Steam knows of more than
// 30,000 EMPTY DayZ servers (idle registrations) and returns at most 10,000 per request, so they cannot
// even be listed completely, while the servers with players are about 3,400 and fit easily. That list
// matched DZSA's for the servers that matter (517 of its 520 with 10+ players) and shows more players.
// Servers the player already knows (favorites, watched ones) are asked directly by the app instead.
//
// The answer is split into `parts` so that, should DayZ ever grow past the 10,000 cap, more slices
// can be added here without changing the app. Each `data` is Steam's own answer, byte for byte:
// {"response":{"servers":[{addr, gameport, name, map, players, max_players, version, gametype, ...}]}}
//
// Nothing is parsed here. That much JSON is more CPU than the free Workers plan allows per request,
// so the answers are only checked at their first bytes and then joined.

const STEAM_URL = 'https://api.steampowered.com/IGameServersService/GetServerList/v1/';
const LIMIT = 10000; // the most Steam returns for one request, whatever is asked for

// Each slice is a Steam master server filter. `required` slices must hold real data for a refresh to count.
// `\\empty\\1` means "not empty". If this ever returns exactly 10,000 servers it is being cut off, and it
// should be split, for example by `\\map\\`.
export const PARTS = [{ name: 'active', filter: '\\appid\\221100\\empty\\1', required: true }];

const FRESH_SECONDS = 300; // how long one copy is served without asking Steam again
const LAST_GOOD_SECONDS = 86400; // how long the last good copy is kept for when Steam is failing
const CLIENT_MAX_AGE = 60;
const UPSTREAM_TIMEOUT_MS = 25000;
const MIN_REQUIRED_BYTES = 10000; // the slice with players is megabytes, a tiny answer means something went wrong

// Cache API entries are keyed by URL. These are never requested from the internet.
const FRESH_KEY = 'https://outpost-api.invalid/v2/servers';
const LAST_GOOD_KEY = 'https://outpost-api.invalid/v2/servers/last-good';

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }
  });
}

/** The request to Steam. The key is the only secret and appears nowhere else. */
export function upstreamUrl(key, filter) {
  const url = new URL(STEAM_URL);
  url.searchParams.set('key', key);
  url.searchParams.set('filter', filter);
  url.searchParams.set('limit', String(LIMIT));
  return url.toString();
}

/** Text that is safe to show: every form of the key is replaced. */
export function redact(text, key) {
  let out = String(text);
  for (const form of [key, encodeURIComponent(key ?? '')]) {
    if (form) out = out.split(form).join('[key]');
  }
  return out;
}

/** Cheap shape check on the first bytes, without parsing. An empty slice is {"response":{}}. */
export function looksLikeSteamAnswer(bytes, required) {
  const head = new TextDecoder().decode(bytes.slice(0, 120)).trimStart();
  if (!head.startsWith('{"response"')) return false;
  if (required) return bytes.byteLength >= MIN_REQUIRED_BYTES && head.includes('"servers"');
  return head.includes('"servers"') || head.replace(/\s/g, '').startsWith('{"response":{}');
}

async function fetchPart(part, env, deps) {
  let res;
  try {
    res = await deps.fetch(upstreamUrl(env.STEAM_API_KEY, part.filter), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (e) {
    // The reason helps with diagnosing, but the underlying message can contain the URL and so the key.
    throw new Error(`Steam did not answer for ${part.name} (${redact(`${e?.name ?? 'Error'}: ${e?.message ?? e}`, env.STEAM_API_KEY)})`);
  }
  // Never put the URL or Steam's own error text in a message: the URL contains the key.
  if (!res.ok) throw new Error(`Steam answered HTTP ${res.status} for ${part.name}`);
  const bytes = await res.arrayBuffer();
  if (!looksLikeSteamAnswer(bytes, part.required)) throw new Error(`Steam sent something that is not a server list for ${part.name}`);
  return bytes;
}

/** Joins the slices into one JSON document without parsing any of them. */
export function joinParts(parts, answers, fetchedAt) {
  const enc = new TextEncoder();
  const pieces = [enc.encode(`{"fetchedAt":${fetchedAt},"parts":[`)];
  parts.forEach((part, i) => {
    pieces.push(enc.encode(`${i ? ',' : ''}{"name":${JSON.stringify(part.name)},"data":`), new Uint8Array(answers[i]), enc.encode('}'));
  });
  pieces.push(enc.encode(']}'));
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out.buffer;
}

function storable(bytes, fetchedAt, maxAge) {
  return new Response(bytes, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}`,
      'x-outpost-fetched-at': String(fetchedAt)
    }
  });
}

function reply(cached, stale, method) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': `public, max-age=${CLIENT_MAX_AGE}`,
    'x-outpost-fetched-at': cached.headers.get('x-outpost-fetched-at') ?? '0',
    'x-outpost-stale': stale ? '1' : '0'
  };
  return new Response(method === 'HEAD' ? null : cached.body, { status: 200, headers });
}

/** Downloads every slice from Steam and stores the joined result. Throws a message that is safe to show. */
async function refresh(env, deps) {
  const parts = deps.parts ?? PARTS;
  // All slices or nothing: a list with a missing slice would quietly lose servers.
  const answers = await Promise.all(parts.map((part) => fetchPart(part, env, deps)));
  const fetchedAt = Math.floor(deps.now() / 1000);
  const bytes = joinParts(parts, answers, fetchedAt);
  await deps.cache.put(FRESH_KEY, storable(bytes, fetchedAt, FRESH_SECONDS));
  await deps.cache.put(LAST_GOOD_KEY, storable(bytes, fetchedAt, LAST_GOOD_SECONDS));
  return { bytes, fetchedAt };
}

// One refresh at a time per isolate, so a burst of requests after expiry asks Steam once.
let inflight = null;

export async function handle(request, env, deps) {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (method !== 'GET' && method !== 'HEAD') return json({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD' });
  if (pathname === '/health') return new Response('ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
  if (pathname !== '/v1/servers') return json({ error: 'not found' }, 404);
  if (!env.STEAM_API_KEY) return json({ error: 'The server list is not configured yet' }, 503);

  const fresh = await deps.cache.match(FRESH_KEY);
  if (fresh) return reply(fresh, false, method);

  try {
    inflight ??= refresh(env, deps).finally(() => (inflight = null));
    const { bytes, fetchedAt } = await inflight;
    return reply(storable(bytes, fetchedAt, FRESH_SECONDS), false, method);
  } catch (e) {
    // Steam is failing: an old list is far better than no list.
    const old = await deps.cache.match(LAST_GOOD_KEY);
    if (old) return reply(old, true, method);
    return json({ error: e.message }, 502);
  }
}

export default {
  // The globals are wrapped, not passed as they are: the Workers runtime refuses to call `fetch`
  // when it is invoked as a method of another object ("Illegal invocation").
  fetch: (request, env) =>
    handle(request, env, { fetch: (url, init) => fetch(url, init), cache: caches.default, now: () => Date.now() })
};
