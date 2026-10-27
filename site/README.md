# Outpost landing page

A static page served by a Cloudflare Worker.

- `public/` is the site: HTML, CSS, self-hosted fonts and screenshots. No third-party requests.
- `src/index.js` is the Worker. It redirects `/download` to the current installer (the installer's
  file name contains its version, so a fixed link would break with each release), answers
  `/api/latest` with the current version, and serves everything else from `public/`.
- `check.mjs` tests the Worker logic: `node check.mjs`.

Run it locally with `npx wrangler dev`, deploy it with `npx wrangler deploy`.

The screenshots show the real app with sample servers, not live data.
