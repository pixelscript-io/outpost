// Cloudflare Worker for the Outpost landing page.
//
// The page itself is static and served from ./public. This script only handles two paths:
//   /download     redirects to the current installer. The installer's file name contains its
//                 version, so a fixed link would break with every release.
//   /api/latest   the current version number, for the page to display.
// Everything else goes to the static assets.

const REPO = 'pixelscript-io/outpost';
const MANIFEST = `https://github.com/${REPO}/releases/latest/download/latest.json`;
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const INSTALLER_PREFIX = `https://github.com/${REPO}/releases/download/`;
const CACHE_SECONDS = 300;

/** The update manifest published with each release, or null if it cannot be read. */
async function readManifest(fetchImpl) {
  try {
    const res = await fetchImpl(MANIFEST, { cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Only ever send people to an installer that lives in our own releases. */
export function installerUrl(manifest) {
  const url = manifest?.platforms?.['windows-x86_64']?.url;
  return typeof url === 'string' && url.startsWith(INSTALLER_PREFIX) ? url : null;
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location, 'cache-control': `public, max-age=${CACHE_SECONDS}` } });
}

export async function handle(request, env, fetchImpl = fetch) {
  const { pathname } = new URL(request.url);
  const mine = pathname === '/download' || pathname === '/api/latest';
  if (!mine) return env.ASSETS.fetch(request);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const manifest = await readManifest(fetchImpl);

  if (pathname === '/download') {
    // If GitHub cannot be reached, the releases page still lets people download it.
    return redirect(installerUrl(manifest) ?? RELEASES);
  }

  const version = typeof manifest?.version === 'string' ? manifest.version : null;
  if (!version) return new Response(JSON.stringify({ error: 'unavailable' }), { status: 502, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ version }), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${CACHE_SECONDS}` }
  });
}

export default {
  fetch: (request, env) => handle(request, env)
};
