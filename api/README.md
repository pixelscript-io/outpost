# Outpost server list API

A small Cloudflare Worker that serves the DayZ server list to the Outpost app. It exists so the Steam
Web API key never has to be inside the app. The Worker holds the key as a secret, asks Steam for the
list, caches it, and the app downloads it from here.

Live at `https://outpost-api.joe-789.workers.dev`

| Path | What it returns |
| --- | --- |
| `GET /v1/servers` | `{"fetchedAt": <unix seconds>, "parts": [{"name": "active", "data": <Steam's JSON>}]}` |
| `GET /health` | `ok` |

Each `data` is Steam's own answer, untouched: `{"response":{"servers":[{addr, gameport, name, map,
players, max_players, version, gametype, ...}]}}`. `addr` is `ip:queryport`. `gametype` is the tag string
(`battleye,no3rd,shardABC123,mod,16:27`).

## What is in the list, and what is not

Measured against the real API (October 2026):

- **Servers with players: about 3,400, with about 21,700 players, 169 KB gzipped.** This is what is served.
  It matched DZSA's list for the servers that matter (517 of its 520 with 10+ players) and shows more players.
- **Empty servers: more than 30,000, and not served.** They are idle registrations. Steam returns at most
  10,000 servers per request whatever `limit` says, and even slicing by map every slice hit that cap, so they
  cannot be listed completely anyway. Servers the player already knows (favorites, watched servers) are asked
  directly by the app instead.
- **No mod lists and no password flag.** Steam's list does not carry them. They come from asking each server
  directly, which a Worker cannot do because Workers cannot send UDP. The app does it for the server you select.

**Watch the cap.** If the list ever has exactly 10,000 servers it is being cut off. Split the slice in
`PARTS` (for example by `\map\`); the app already reads `parts`, so nothing else changes.

## How it behaves

- One copy is served for 5 minutes. A burst of requests after it expires asks Steam once.
- If Steam fails, the last good copy (kept for 24 hours) is served with `x-outpost-stale: 1`. With no copy at
  all it answers 502.
- Every response carries `x-outpost-fetched-at`, the Unix time the list was taken from Steam.
- It never parses the list. That much JSON is more CPU than the free Workers plan allows per request.
- A bad answer from Steam (an error, HTML, a tiny reply) is never cached and never replaces a good copy.
- With several slices, all of them must succeed for a refresh to count. A list with a hole would quietly lose servers.
- Without a key it answers 503 and sends nothing to Steam.
- Query parameters from callers are ignored, so it is not an open proxy to Steam.
- Error messages show why Steam could not be reached, with the key replaced by `[key]`.

## Setting the key (once)

1. Sign in to Steam and open https://steamcommunity.com/dev/apikey. Steam asks for a domain name, and
   anything works, for example `outpost-api.joe-789.workers.dev`. The account must be unlocked, which
   means having spent at least $5 on Steam.
2. From this folder, store it as a secret. The prompt hides what you paste, so the key never appears
   in a terminal history or a file:

   ```
   npx wrangler secret put STEAM_API_KEY
   ```
3. Check it: `curl -H "Accept-Encoding: gzip" https://outpost-api.joe-789.workers.dev/v1/servers` should return
   JSON that starts with `{"fetchedAt":`.

Treat the key like a password. Steam's terms forbid sharing it, and they limit how many calls a key may
make per day (100,000 at the time of writing, and this Worker makes a few hundred at most). To rotate
it, make a new key on the same page and run the `secret put` command again.

## Things worth knowing

- Observability is switched off on purpose. Request traces can record the URLs of outgoing requests,
  and the request to Steam carries the key in its URL.
- Cloudflare calls `fetch` strictly: it must not be invoked as a method of another object. The entry point
  wraps the globals for that reason, and `check.mjs` has a test that mimics the strictness, because the
  fakes alone could not catch it (it did cause a real failure once).
- For local runs with `npx wrangler dev`, put `STEAM_API_KEY=...` in a file named `.dev.vars` here. It
  is git-ignored.

## Checking and deploying

```
node check.mjs          # tests against a fake Steam and a fake cache
npx wrangler deploy
```
