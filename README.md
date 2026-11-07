# SpeedPulse

A minimal private web app for continuously recording website performance history using Google PageSpeed Insights + Chrome UX Report.

## Features

- Projects and website collections
- Manual website entry
- CSV preview/import
- Mobile and desktop PageSpeed monitoring
- Automatic daily/weekly schedules
- Cloudflare Cron Trigger scheduler
- D1 persistent historical database
- Performance, Accessibility, SEO, and Best Practices scores
- Lighthouse FCP, LCP, TBT, CLS, Speed Index
- CrUX real-user LCP, INP, CLS
- 7D / 30D / 90D / 1Y / all-time SVG line charts
- Latest-score overview and attention list
- Failed test history/status
- Per-site monitoring settings
- Optimization notes
- CSV history export
- Private admin login with signed HttpOnly session cookie
- No frontend framework or chart library dependency
- No Render, VPS, Redis, Celery, or paid cron requirement

## Stack

```text
Cloudflare Worker        API + auth + scheduler
Cloudflare Static Assets HTML/CSS/JS dashboard
Cloudflare D1            historical SQL storage
Cloudflare Cron Trigger  due-test scheduler
Google PSI API v5        Lighthouse lab data
Chrome UX Report API     real-user Core Web Vitals
```


## Recovered live deployment

This copy is prepared to update the existing `speedpulse` Cloudflare Worker. See **[RECOVERY_DEPLOY.md](RECOVERY_DEPLOY.md)** before deploying or rotating the admin credentials. The UI changes are summarized in **[CHANGES.md](CHANGES.md)**.

## Start here

Read **[SETUP.md](SETUP.md)** for the complete deployment walkthrough, including the exact step where you paste your Google API key.

Read **[ARCHITECTURE.md](ARCHITECTURE.md)** for the system design and data-flow explanation.

## Quick command map

```bash
# 1. Install dependencies
npm install

# 2. Authenticate with Cloudflare
npx wrangler login

# 3. Create Cloudflare resources (100% Free Tier)
npx wrangler d1 create speedpulse-db
npx wrangler queues create speedpulse-scans
npx wrangler queues create speedpulse-scans-dlq
npx wrangler kv namespace create speedpulse-reports

# 4. Bind resource IDs into wrangler.jsonc
node scripts/set-db-id.mjs <YOUR_D1_DATABASE_ID> <YOUR_KV_NAMESPACE_ID>

# 5. Apply database migrations
npm run db:migrate:remote

# 6. (Optional) Seed 6 public benchmark websites (Wikipedia, GitHub, Cloudflare, etc.)
npm run seed:demo:remote

# 7. Set admin security credentials
npx wrangler secret put ADMIN_PASSWORD
node scripts/generate-secret.mjs
npx wrangler secret put SESSION_SECRET

# 8. Deploy to Cloudflare
npm run deploy

# 9. Google PageSpeed API Key:
# Enter your key directly in the web UI under Settings (or via wrangler secret put GOOGLE_API_KEY)
```

## CSV format

```csv
name,url
Example,https://example.com/
Web.dev,https://web.dev/
```

See `samples/sites.csv`.

## Source layout

```text
speedpulse/
├── src/
│   ├── index.ts        Worker routes + scheduled handler
│   ├── auth.ts         signed admin session
│   ├── db.ts           test execution + D1 persistence
│   ├── pagespeed.ts    PSI and CrUX API clients
│   ├── types.ts
│   ├── utils.ts
│   └── cloudflare.d.ts
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── migrations/
│   └── 0001_init.sql
├── samples/
│   └── sites.csv
├── scripts/
│   ├── generate-secret.mjs
│   └── set-db-id.mjs
├── wrangler.jsonc
├── package.json
├── tsconfig.json
├── SETUP.md
└── ARCHITECTURE.md
```

## License

Use and modify this project for your own sites and internal monitoring.
