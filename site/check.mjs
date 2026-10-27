import assert from 'node:assert/strict';
import { handle, installerUrl } from './src/index.js';

const GOOD = 'https://github.com/pixelscript-io/outpost/releases/download/v0.2.0/Outpost_0.2.0_x64-setup.exe';
const manifest = { version: '0.2.0', platforms: { 'windows-x86_64': { url: GOOD, signature: 'x' } } };
const env = { ASSETS: { fetch: async () => new Response('asset', { status: 200 }) } };
const req = (path, method = 'GET') => new Request('https://example.com' + path, { method });
const serving = (body, ok = true) => async () => new Response(JSON.stringify(body), { status: ok ? 200 : 404 });
const failing = async () => { throw new Error('network down'); };

// /download redirects to the current installer
let res = await handle(req('/download'), env, serving(manifest));
assert.equal(res.status, 302);
assert.equal(res.headers.get('location'), GOOD);

// a manifest pointing anywhere else is never followed
for (const evil of ['https://evil.example/setup.exe', 'http://github.com/pixelscript-io/outpost/releases/download/x', 'javascript:alert(1)', 42]) {
  const bad = { platforms: { 'windows-x86_64': { url: evil } } };
  assert.equal(installerUrl(bad), null);
  res = await handle(req('/download'), env, serving(bad));
  assert.equal(res.headers.get('location'), 'https://github.com/pixelscript-io/outpost/releases/latest');
}

// GitHub unreachable or no release yet: fall back to the releases page
for (const f of [failing, serving({}, false), serving('not an object')]) {
  res = await handle(req('/download'), env, f);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://github.com/pixelscript-io/outpost/releases/latest');
}

// /api/latest
res = await handle(req('/api/latest'), env, serving(manifest));
assert.deepEqual(await res.json(), { version: '0.2.0' });
res = await handle(req('/api/latest'), env, failing);
assert.equal(res.status, 502);

// only GET and HEAD
res = await handle(req('/download', 'POST'), env, serving(manifest));
assert.equal(res.status, 405);

// everything else is the static site
res = await handle(req('/'), env, failing);
assert.equal(await res.text(), 'asset');

console.log('worker: all checks passed');
