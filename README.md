# SpeedPulse

[![Live Demo](https://img.shields.io/badge/Live%20Demo-speedpulse--demo-blue?style=for-the-badge&logo=cloudflare)](https://speedpulse-demo.pagespeed-monitor.workers.dev)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1%20%2B%20Queues-F38020?style=for-the-badge&logo=cloudflare)](https://workers.cloudflare.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](LICENSE)

A high-performance, self-hosted web app for continuously recording website performance history using Google PageSpeed Insights + Chrome UX Report on Cloudflare's serverless edge.

---

### 🚀 Live Interactive Demo

Experience the live app running in an isolated environment on Cloudflare Workers, D1, and Queues:

- **Live URL:** [https://speedpulse-demo.pagespeed-monitor.workers.dev](https://speedpulse-demo.pagespeed-monitor.workers.dev)
- **Demo Password:** `demo` (or click **"1-Click Sign In"** on the login screen)
- **Pre-loaded Benchmarks:** Pre-seeded with 6 top web properties (Wikipedia, GitHub, Cloudflare, Web.dev, Hacker News, MDN) and 5 days of metrics, CrUX data, and interactive SVG trend graphs.
- **In-App Setup:** You can optionally enter your own Google PageSpeed Insights API key via **Settings** in the UI to trigger on-demand scans.

---

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

## Documentation

- **[SETUP.md](SETUP.md)**: Complete deployment walkthrough, including 1-click resource creation and Google API key setup.
- **[ARCHITECTURE.md](ARCHITECTURE.md)**: System design, queue worker concurrency, quota ledger, and retention rollups.
- **[CHANGES.md](CHANGES.md)**: UI and architectural changelog.

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
