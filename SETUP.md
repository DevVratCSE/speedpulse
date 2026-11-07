# SpeedPulse — Complete Setup and Deployment

This guide takes the ZIP from your computer to a live Cloudflare URL.

## What you need

1. A free Cloudflare account.
2. A Google Cloud project.
3. Node.js 20+ installed (Node 22 is a good choice).
4. The extracted `speedpulse` project folder.

No Render account, VPS, paid cron service, PostgreSQL server, or Redis server is required.

---

## Step 1 — Extract the ZIP

Extract the project and open a terminal inside the `speedpulse` folder.

```bash
cd speedpulse
```

Install the local development/deployment dependency:

```bash
npm install
```

Check the source:

```bash
npm run check
```

---

## Step 2 — Log in to Cloudflare from Wrangler

Run:

```bash
npx wrangler login
```

A browser window opens. Authorize Wrangler for your Cloudflare account.

---

## Step 3 — Create the free Cloudflare resources

Run:

```bash
# 1. Create the D1 database
npx wrangler d1 create speedpulse-db

# 2. Create the scan queues (Free tier: 10,000 operations/day)
npx wrangler queues create speedpulse-scans
npx wrangler queues create speedpulse-scans-dlq

# 3. Create the KV namespace for reports (Free tier: 100,000 reads/day)
npx wrangler kv namespace create speedpulse-reports
```

Wrangler prints IDs for your database and KV namespace. Put them into `wrangler.jsonc` automatically:

```bash
node scripts/set-db-id.mjs <YOUR_D1_DATABASE_ID> <YOUR_KV_NAMESPACE_ID>
```

Example:

```bash
node scripts/set-db-id.mjs aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj
```

You can confirm they were written into `wrangler.jsonc` under `d1_databases[0].database_id` and `kv_namespaces[0].id`.

---

## Step 4 — Create the database tables

Run the included D1 migrations against the real Cloudflare database:

```bash
npm run db:migrate:remote
```

Approve the prompt if Wrangler asks for confirmation.

This creates:

- `projects` & `sites`
- `scan_jobs` & `scan_targets` (next-generation control plane)
- `test_runs` & `metrics`
- `metrics_daily_rollup` (retention & percentile history)
- `quota_ledger` (automatic daily limit protection)
- `report_payloads` (D1 detailed report storage)
- `site_latest` & `annotations`

---

## Step 4.5 — (Optional) Seed the demo public benchmark websites

If you want an instant working dashboard with realistic data and history (Wikipedia, GitHub, Cloudflare, WordPress.org, Hacker News, MDN Web Docs) without adding your own sites yet, run:

```bash
npm run seed:demo:remote
```

This seeds 6 public websites, 12 active scan targets, and 5 days of history.

---

## Step 5 — Create your Google API key

In Google Cloud Console:

1. Create or select a Google Cloud project.
2. Open **APIs & Services → Library**.
3. Enable **PageSpeed Insights API**.
4. Also enable **Chrome UX Report API**. This is used for real-user LCP, INP, and CLS.
5. Open **APIs & Services → Credentials**.
6. Choose **Create credentials → API key**.
7. Copy the generated API key.
8. Recommended: edit the key and add API restrictions so it can call only PageSpeed Insights API and Chrome UX Report API.

Do not put this key in `public/app.js`, `wrangler.jsonc`, GitHub, or any frontend file.

---

## Step 6 — Make the first Cloudflare deployment

Run:

```bash
npm run deploy
```

Wrangler deploys:

- the Worker API
- the static dashboard
- the D1 binding
- the Cron Trigger

At this moment the site exists, but login will report that secrets are not configured. That is expected.

---

# Step 7 — Add your Google PageSpeed API key

You can add your Google PageSpeed API key in either of two ways:

### Option A: Directly in the Web Dashboard (Recommended — Zero Terminal Friction)
1. Complete Step 8 and Step 9 below to set your password.
2. Open your live Cloudflare Worker URL in your browser.
3. Sign in with your admin password.
4. You will see an onboarding banner: **⚡ Google PageSpeed API Key Not Configured**.
5. Click **Configure Key** (or open **Settings** in the sidebar).
6. Paste your Google PageSpeed API key and click **Save Key**. The key is stored securely in your private D1 database.

### Option B: Via Cloudflare Secret (CLI)
Run:

```bash
npx wrangler secret put GOOGLE_API_KEY
```

Wrangler will prompt:

```text
Enter a secret value:
```

**Paste your Google API key at that prompt and press Enter.**

The key becomes an encrypted Worker secret. (Worker secrets take precedence over database keys).

---

## Step 8 — Create your dashboard password

Choose a strong password that you will use on the SpeedPulse login screen.

Run:

```bash
npx wrangler secret put ADMIN_PASSWORD
```

When prompted, paste/type your chosen password and press Enter.

---

## Step 9 — Create the session signing secret

Generate a strong random value:

```bash
node scripts/generate-secret.mjs
```

It prints a long random string. Copy it.

Then run:

```bash
npx wrangler secret put SESSION_SECRET
```

Paste the generated random string at the prompt.

Do not use your admin password as the session secret.

---

## Step 10 — Deploy once more

Run:

```bash
npm run deploy
```

This ensures the latest code/config/Cron Trigger is the active deployment after all setup changes.

Wrangler prints your live URL, normally similar to:

```text
https://speedpulse.<your-subdomain>.workers.dev
```

Open that URL.

---

## Step 11 — Sign in

Use the password you entered for:

```text
ADMIN_PASSWORD
```

You should now see the SpeedPulse dashboard.

---

## Step 12 — Create your first project

1. Click **New project**.
2. Give it a name, for example `SEO Clients`.
3. Open the project.
4. Add one website manually or import a CSV.

A newly added daily/weekly site is immediately marked as due, so the scheduler can pick it up on a coming 5-minute Cron invocation.

You can also open the site and click **Run mobile** or **Run desktop** for an immediate manual test.

---

## Step 13 — Import a CSV

Use the included file as a template:

```text
samples/sites.csv
```

Minimum CSV:

```csv
url
https://example.com/
https://web.dev/
```

Recommended CSV:

```csv
name,url
Example,https://example.com/
Web.dev,https://web.dev/
```

The app:

1. reads the CSV in your browser;
2. validates URLs;
3. removes duplicates inside the CSV preview;
4. shows a preview;
5. uploads valid sites in batches of 50;
6. uses D1 uniqueness rules to skip sites already in the project.

The raw CSV file itself is not stored.

---

## Step 14 — How automatic scheduling works

`wrangler.jsonc` contains:

```json
"triggers": {
  "crons": ["*/5 * * * *"]
}
```

Every 5 minutes Cloudflare invokes the scheduled Worker.

The Worker does not test every site every 5 minutes. It selects only the oldest site/strategy whose `next_check_at` is due, runs one PageSpeed + CrUX collection, stores it, then calculates the next due time.

Defaults:

```text
Mobile:  daily
Desktop: weekly
```

For 100 sites that is roughly 114 monitoring targets/day on average (100 daily mobile + ~14 desktop/day), while one run every 5 minutes gives up to 288 scheduler slots/day before accounting for errors/limits. This is intentionally spread out rather than bursty.

---

## Step 15 — Core Web Vitals behavior

The dashboard uses the Chrome UX Report API for real-user field metrics:

- Largest Contentful Paint (LCP)
- Interaction to Next Paint (INP)
- Cumulative Layout Shift (CLS)

These are origin-level p75 values for the selected device type.

Some websites do not have enough Chrome traffic for CrUX. The dashboard will show **No field data** for those sites. That is not an application error.

---

## Step 16 — What is stored historically

For every successful test, SpeedPulse stores:

### Lighthouse

- Performance score
- Accessibility score
- SEO score
- Best Practices score
- FCP
- LCP
- TBT
- CLS
- Speed Index
- Lighthouse version/time

### CrUX

- field LCP p75
- field INP p75
- field CLS p75
- collection period

The app deliberately does **not** store the giant full Lighthouse JSON response.

---

## Step 17 — History charts

Open a site and choose:

- Mobile / Desktop
- Performance
- Accessibility
- SEO
- Best Practices
- Field LCP
- Field INP
- Field CLS
- Lab LCP
- TBT
- Lab CLS

Date ranges:

- 7 days
- 30 days
- 90 days
- 1 year
- all retained history

The charts are plain SVG rendered by the included JavaScript; no chart CDN/library is required.

---

## Step 18 — Export historical data

Open a site and click **Export CSV**.

The export contains all historical metric snapshots for the currently selected Mobile/Desktop strategy.

---

## Step 19 — Add optimization notes

Use **Optimization notes** on a site page for entries such as:

```text
Enabled full-page cache
Removed unused Elementor widget
Changed hero image to WebP
Deferred third-party analytics
```

The notes remain attached to the site for future reference.

---

## Step 20 — Local development (optional)

Copy:

```text
.dev.vars.example
```

to:

```text
.dev.vars
```

Fill it like this:

```text
GOOGLE_API_KEY=your-key
ADMIN_PASSWORD=your-local-password
SESSION_SECRET=a-long-random-string-at-least-32-characters
```

Create the local D1 tables:

```bash
npm run db:migrate:local
```

Start the local app:

```bash
npm run dev
```

Wrangler prints a localhost URL.

For local Cron testing, Wrangler supports invoking the scheduled handler from its special scheduled test endpoint. The exact route is shown by current Wrangler documentation/output; do not expose a custom public cron endpoint in this project.

Never commit `.dev.vars`. It is ignored by `.gitignore`.

---

## Step 21 — Update the app later

After editing files:

```bash
npm run check
npm run deploy
```

If a later ZIP version includes an additional D1 migration:

```bash
npm run db:migrate:remote
npm run deploy
```

Do not rerun `d1 create` for normal application updates.

---

## Step 22 — Optional custom domain

The free `workers.dev` address is enough to use the app.

If you already control a domain in Cloudflare, you can optionally attach a custom Worker domain from the Cloudflare dashboard. This is not required for SpeedPulse to operate.

---

## Important free-tier notes

The architecture is designed to stay at a zero-monthly-cost target for modest personal/internal monitoring, but "free" means **within the current free quotas and limits** of Cloudflare and Google. Providers can change limits, and unusually large collections can exceed them.

The project is deliberately conservative:

- one due target per 5-minute Cron invocation;
- PageSpeed partial responses;
- no raw Lighthouse JSON storage;
- indexed D1 history tables;
- static frontend assets;
- no paid external scheduler;
- no always-on server.

If you grow beyond the default throughput, first review Cloudflare Worker CPU limits and Google API quota before increasing `SCHEDULE_BATCH_SIZE`.

---

## Troubleshooting

### Login says secrets are not configured

Run:

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
```

Then deploy again.

### PageSpeed says GOOGLE_API_KEY is not configured

Run:

```bash
npx wrangler secret put GOOGLE_API_KEY
```

Paste the key when prompted.

### Lighthouse works but Core Web Vitals are always empty

Check that **Chrome UX Report API** is enabled for the same Google Cloud project/key. Also remember that low-traffic sites may have no CrUX record.

### Database errors immediately after deploy

Make sure you applied:

```bash
npm run db:migrate:remote
```

and that the correct D1 ID is present in `wrangler.jsonc`.

### A CSV row is skipped

The CSV requires a `url` header. Invalid URLs and duplicates inside the upload are skipped during preview. URLs that already exist in that project are ignored by the database.

### Scheduled tests are slow to work through a large new import

That is intentional. The free-friendly scheduler processes one due target every 5 minutes. You can run important sites manually immediately while the queue works through the rest.
