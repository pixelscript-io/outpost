import assert from 'node:assert/strict';
import { handle, upstreamUrl, looksLikeSteamAnswer, redact, PARTS as REAL_PARTS } from './src/index.js';

const SECRET = 'TEST-KEY-0123456789ABCDEF';
const clock = { now: 1_800_000_000_000 };

// The real configuration is one slice. The multi-slice behaviour (joining, one failing slice, an empty
// slice) is still tested, with slices defined here, because it is what makes growth possible.
const PARTS = [
  { name: 'main', filter: '\\appid\\221100\\empty\\1', required: true },
  { name: 'extra-one', filter: '\\appid\\221100\\noplayers\\1\\map\\a' },
  { name: 'extra-two', filter: '\\appid\\221100\\noplayers\\1\\map\\b' },
  { name: 'extra-three', filter: '\\appid\\221100\\noplayers\\1\\nor\\2\\map\\a\\map\\b' }
];
const PART_COUNT = PARTS.length;

/** Behaves like the Workers Cache API: entries expire after their max-age. */
function fakeCache() {
  const store = new Map();
  return {
    store,
    async match(key) {
      const e = store.get(key);
      if (!e || clock.now >= e.expires) return undefined;
      return new Response(e.bytes, { headers: e.headers });
    },
    async put(key, res) {
      const max = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1]);
      assert.ok(max > 0, 'cached responses must say how long they live');
      store.set(key, { bytes: await res.arrayBuffer(), headers: Object.fromEntries(res.headers), expires: clock.now + max * 1000 });
    }
  };
}

/** A believable Steam answer, bigger than the minimum size, shaped like the real one. */
function steamBody(n = 120, tag = 'x') {
  const servers = Array.from({ length: n }, (_, i) => ({
    addr: `185.${tag.charCodeAt(0) % 250}.${i % 250}.${(i % 200) + 1}:27016`, gameport: 2302, steamid: String(90000000000000000n + BigInt(i)),
    name: `Server ${i} ${'x'.repeat(40)}`, appid: 221100, gamedir: 'dayz', version: '1.30.164200', product: 'dayz', region: 255,
    players: i % 60, max_players: 60, bots: 0, map: 'chernarusplus', secure: true, dedicated: true, os: 'w', gametype: 'battleye,no3rd,mod,12:00'
  }));
  return JSON.stringify({ response: { servers } });
}

const partFor = (url) => [...PARTS, ...REAL_PARTS].find((p) => p.filter === new URL(url).searchParams.get('filter'));
const goodAnswer = (url) => new Response(partFor(url).required ? steamBody(200, 'a') : steamBody(30, partFor(url).name), { status: 200 });

function setup({ key = SECRET, steam } = {}) {
  const calls = [];
  const cache = fakeCache();
  const deps = {
    cache,
    parts: PARTS,
    now: () => clock.now,
    fetch: async (url, init) => {
      calls.push(String(url));
      return (steam ?? goodAnswer)(String(url), init);
    }
  };
  const env = key === null ? {} : { STEAM_API_KEY: key };
  const get = (path = '/v1/servers', method = 'GET') => handle(new Request('https://api.example.com' + path, { method }), env, deps);
  return { calls, cache, get };
}

const wholeResponseText = async (res) => `${[...res.headers].join('\n')}\n${await res.text()}`;
const lastKey = 'https://outpost-api.invalid/v2/servers/last-good';

// ---- the real configuration: one slice, the servers that have players
assert.equal(REAL_PARTS.length, 1);
assert.equal(REAL_PARTS[0].name, 'active');
assert.equal(REAL_PARTS[0].filter, '\\appid\\221100\\empty\\1');
assert.equal(REAL_PARTS[0].required, true);

// ---- the requests to Steam are exactly what we mean them to be
for (const part of PARTS) {
  const url = new URL(upstreamUrl(SECRET, part.filter));
  assert.equal(url.origin + url.pathname, 'https://api.steampowered.com/IGameServersService/GetServerList/v1/');
  assert.equal(url.searchParams.get('key'), SECRET);
  assert.equal(url.searchParams.get('filter'), part.filter);
  assert.equal(url.searchParams.get('limit'), '10000');
}
// the slices must not overlap: active servers are non-empty, the rest are empty and split by map
assert.equal(PARTS.filter((p) => p.required).length, 1);
assert.ok(PARTS[0].filter.includes('\\empty\\1') && !PARTS[0].filter.includes('noplayers'));
assert.ok(PARTS.slice(1).every((p) => p.filter.includes('\\noplayers\\1')));
assert.equal(new Set(PARTS.map((p) => p.filter)).size, PART_COUNT);
assert.equal(new Set(PARTS.map((p) => p.name)).size, PART_COUNT);

// ---- the client cannot change what is asked
{
  const { calls, get } = setup();
  await get('/v1/servers?key=stolen&filter=%5Cappid%5C730&limit=1');
  assert.equal(calls.length, PART_COUNT);
  for (const c of calls) {
    assert.equal(new URL(c).searchParams.get('key'), SECRET);
    assert.ok(PARTS.some((p) => p.filter === new URL(c).searchParams.get('filter')));
  }
}

// ---- cold cache: every slice is fetched once, and joined without being altered
{
  clock.now += 10_000_000;
  const { calls, get } = setup();
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('x-outpost-stale'), '0');
  const fetchedAt = Math.floor(clock.now / 1000);
  assert.equal(Number(res.headers.get('x-outpost-fetched-at')), fetchedAt);
  const body = JSON.parse(await res.text());
  assert.equal(body.fetchedAt, fetchedAt);
  assert.deepEqual(body.parts.map((p) => p.name), PARTS.map((p) => p.name));
  assert.equal(JSON.stringify(body.parts[0].data), steamBody(200, 'a'), 'Steam\'s JSON is not altered');
  assert.equal(body.parts[1].data.response.servers.length, 30);
  assert.equal(calls.length, PART_COUNT);
}

// ---- warm cache: no calls to Steam until the copy expires, then one round again
{
  clock.now += 10_000_000;
  const { calls, get } = setup();
  await get();
  clock.now += 299_000;
  await get();
  await get();
  assert.equal(calls.length, PART_COUNT, 'served from cache for 5 minutes');
  clock.now += 2_000;
  await get();
  assert.equal(calls.length, PART_COUNT * 2, 'refreshed after expiry');
}

// ---- a burst of requests after expiry asks Steam once
{
  clock.now += 10_000_000;
  const { calls, get } = setup();
  const results = await Promise.all(Array.from({ length: 12 }, () => get()));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(calls.length, PART_COUNT);
}

// ---- Steam failing: serve the last good list, flagged as stale
const failures = {
  'an HTTP error': () => new Response('Forbidden', { status: 403 }),
  'HTML instead of JSON': () => new Response('<html>maintenance</html>', { status: 200 }),
  'an empty required slice': () => new Response('{"response":{}}', { status: 200 }),
  'a network error': () => { throw new Error('network down'); }
};
for (const [name, failure] of Object.entries(failures)) {
  clock.now += 10_000_000;
  let broken = false;
  const { get, calls } = setup({ steam: (url) => (broken ? failure() : goodAnswer(url)) });
  const good = await (await get()).text();
  broken = true;
  clock.now += 400_000; // fresh copy expired, last good copy still kept
  const res = await get();
  assert.equal(res.status, 200, name);
  assert.equal(res.headers.get('x-outpost-stale'), '1', name);
  assert.equal(await res.text(), good, name);
  assert.equal(calls.length, PART_COUNT * 2, name);
}

// ---- one failing slice fails the whole refresh: a list with a hole would quietly lose servers
{
  clock.now += 10_000_000;
  let broken = false;
  const { get } = setup({ steam: (url) => (broken && partFor(url).name === 'extra-two' ? new Response('', { status: 500 }) : goodAnswer(url)) });
  const good = await (await get()).text();
  broken = true;
  clock.now += 400_000;
  const res = await get();
  assert.equal(res.headers.get('x-outpost-stale'), '1');
  assert.equal(await res.text(), good, 'the old complete list is served, not a new list with a hole');
  // and with nothing saved it is an error that names the slice
  clock.now += 90_000_000;
  const none = setup({ steam: (url) => (partFor(url).name === 'extra-two' ? new Response('', { status: 500 }) : goodAnswer(url)) });
  const failed = await none.get();
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /HTTP 500 for extra-two/);
}

// ---- an empty slice is normal (no empty servers on some map), but an empty required slice is not
{
  clock.now += 10_000_000;
  const { get } = setup({ steam: (url) => (partFor(url).name === 'extra-three' ? new Response('{"response":{}}', { status: 200 }) : goodAnswer(url)) });
  const res = await get();
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.deepEqual(body.parts[3].data, { response: {} });
}

// ---- Steam failing with nothing saved: an error that is honest and says nothing secret
for (const failure of [
  () => new Response(`bad key ${SECRET}`, { status: 403 }),
  () => new Response('<html>' + 'x'.repeat(20000) + '</html>', { status: 200 }),
  () => { throw new Error(`could not connect to ${upstreamUrl(SECRET, PARTS[0].filter)}`); }
]) {
  clock.now += 10_000_000;
  const { get } = setup({ steam: failure });
  const res = await get();
  assert.equal(res.status, 502);
  const text = await wholeResponseText(res);
  assert.ok(!text.includes(SECRET), 'the key must never appear in a response');
  assert.ok(JSON.parse(text.split('\n').pop()).error.length > 0);
}
{
  // the reason is shown so problems can be diagnosed, with the key replaced
  clock.now += 10_000_000;
  const { get } = setup({ steam: () => { throw new TypeError(`fetch failed for ${upstreamUrl(SECRET, PARTS[0].filter)}`); } });
  const { error } = await (await get()).json();
  assert.match(error, /Steam did not answer for \w[\w-]* \(TypeError: fetch failed for https:\/\/api\.steampowered\.com\//);
  assert.ok(error.includes('[key]') && !error.includes(SECRET));
  assert.equal(redact(`a ${encodeURIComponent('K/E+Y')} b`, 'K/E+Y'), 'a [key] b');
}

// ---- a bad answer is never cached, and an old good copy is not replaced by it
{
  clock.now += 10_000_000;
  let mode = 'good';
  const { get, cache } = setup({ steam: (url) => (mode === 'good' ? goodAnswer(url) : new Response('nope', { status: 200 })) });
  await get();
  const before = cache.store.get(lastKey).bytes.byteLength;
  mode = 'bad';
  clock.now += 400_000;
  await get();
  assert.equal(cache.store.get(lastKey).bytes.byteLength, before);
}

// ---- the stale copy does not live forever
{
  clock.now += 10_000_000;
  let broken = false;
  const { get } = setup({ steam: (url) => (broken ? new Response('', { status: 500 }) : goodAnswer(url)) });
  await get();
  broken = true;
  clock.now += 90_000_000; // more than a day
  assert.equal((await get()).status, 502);
}

// ---- not configured, wrong method, unknown path, health, HEAD
{
  const { get, calls } = setup({ key: null });
  assert.equal((await get()).status, 503);
  assert.equal(calls.length, 0, 'without a key nothing is sent to Steam');
}
{
  const { get } = setup();
  assert.equal((await get('/v1/servers', 'POST')).status, 405);
  assert.equal((await get('/v1/servers', 'DELETE')).status, 405);
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await get('/')).status, 404);
  const health = await get('/health');
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');
  const head = await get('/v1/servers', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
}

// ---- the real entry point, with globals as strict as Cloudflare's: `fetch` must not be called as a
// method of another object. This is the bug that the fakes above could not see.
{
  clock.now += 10_000_000;
  const realFetch = globalThis.fetch;
  const realCaches = globalThis.caches;
  let strictCalls = 0;
  globalThis.fetch = function (url) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
    strictCalls += 1;
    return Promise.resolve(goodAnswer(String(url)));
  };
  globalThis.caches = { default: fakeCache() };
  try {
    const worker = (await import('./src/index.js')).default;
    const res = await worker.fetch(new Request('https://api.example.com/v1/servers'), { STEAM_API_KEY: SECRET });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(strictCalls, REAL_PARTS.length);
    assert.equal((await worker.fetch(new Request('https://api.example.com/v1/servers'), { STEAM_API_KEY: SECRET })).headers.get('x-outpost-stale'), '0');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.caches = realCaches;
  }
}

// ---- the shape check
const bytes = (text) => new TextEncoder().encode(text).buffer;
assert.equal(looksLikeSteamAnswer(bytes(steamBody(200)), true), true);
assert.equal(looksLikeSteamAnswer(bytes('{"response":{"servers":[]}}'), true), false, 'too small to be the main list');
assert.equal(looksLikeSteamAnswer(bytes('x'.repeat(20000)), true), false);
assert.equal(looksLikeSteamAnswer(bytes('{"response":{}}' + ' '.repeat(20000)), true), false, 'the main slice must have servers');
assert.equal(looksLikeSteamAnswer(bytes('{"response":{}}'), false), true, 'an empty slice is fine');
assert.equal(looksLikeSteamAnswer(bytes('{"response": {} }'), false), true);
assert.equal(looksLikeSteamAnswer(bytes(steamBody(3)), false), true);
assert.equal(looksLikeSteamAnswer(bytes('<html>'), false), false);
assert.equal(looksLikeSteamAnswer(bytes('{"error":"nope"}'), false), false);

console.log('api worker: all checks passed');
