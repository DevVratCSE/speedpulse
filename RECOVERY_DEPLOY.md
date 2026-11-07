# SpeedPulse — Recovered Source Deployment

This project folder is the recovered editable source for the existing live Worker named `speedpulse`.

## What is already wired

- Worker name: `speedpulse`
- Static assets: `public/` via the `ASSETS` binding
- D1 binding used by the code: `DB`
- D1 database name: `speedpulse-db`
- D1 database ID in this config: `REPLACE_WITH_YOUR_D1_DATABASE_ID`
- Cron: every 5 minutes

Before deploying, verify that the D1 ID above is the same database attached to the live Worker in Cloudflare.

## Safe update flow for the existing live app

From the extracted `speedpulse` directory:

```bash
npm install
npx wrangler login
npx wrangler whoami
npx wrangler d1 list
npm run check
npm run deploy
```

`npm run deploy` updates the existing Worker named `speedpulse`; it does not create a second Worker as long as you are logged into the same Cloudflare account.

Do **not** run `wrangler d1 create speedpulse-db` again. The live app already has a database.

## Rotate the exposed admin credentials

The admin password and session signing secret are Cloudflare Worker secrets, so they are intentionally not stored in this ZIP.

Choose a new admin password and run:

```bash
npx wrangler secret put ADMIN_PASSWORD
```

Enter the new password when Wrangler prompts you.

Then generate a fresh session secret:

```bash
node scripts/generate-secret.mjs
```

Copy the generated value and run:

```bash
npx wrangler secret put SESSION_SECRET
```

Paste the generated value when prompted. Rotating `SESSION_SECRET` signs out existing sessions, which is desirable after a credential leak.

You normally do **not** need to re-enter `GOOGLE_API_KEY` when deploying this UI update; existing Cloudflare secrets remain attached to the Worker.

## UI changes in this version

- New professional slate / indigo visual system
- Refined navigation, cards, tables, forms, modal, login screen, and responsive layout
- Project list no longer shows average performance
- Dashboard no longer shows average performance; it shows sites needing attention instead
- Project detail table now shows only:
  - Site
  - Mobile score
  - Desktop score
  - Mobile LCP
  - Status
- Mobile LCP uses the latest Lighthouse mobile LCP so it remains useful even when CrUX field data is unavailable
- Site detail and history panels have been visually refreshed
- Settings now includes password/session-secret rotation commands

## Rollback

If the deployment has a problem, use Cloudflare Dashboard → Workers & Pages → `speedpulse` → Deployments and roll back to the previous known-good deployment.
