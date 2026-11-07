# SpeedPulse Architecture

## Goal

SpeedPulse is a zero-monthly-cost-target monitoring dashboard for a collection of websites. It periodically records Google Lighthouse scores and CrUX Core Web Vitals, stores snapshots in Cloudflare D1, and renders historical charts in a private web app.

## Components

```text
Browser
  |
  | HTTPS
  v
Cloudflare Worker + Static Assets
  |-- serves HTML/CSS/JS
  |-- /api/* application API
  |-- signed admin session cookie
  |-- CSV import endpoints
  |-- manual PageSpeed runs
  |
  +------> Cloudflare D1
  |          projects
  |          sites
  |          test_runs
  |          metrics
  |          site_latest
  |          annotations
  |
  +------> Google PageSpeed Insights API v5
  |          Lighthouse performance
  |          accessibility
  |          SEO
  |          best practices
  |          lab metrics
  |
  +------> Chrome UX Report API
             LCP p75
             INP p75
             CLS p75

Cloudflare Cron Trigger (every 5 minutes)
  |
  +--> finds the oldest due monitoring target
       --> runs one test
       --> stores snapshot
       --> schedules its next daily/weekly check
```

## Why one test per cron invocation?

The Workers Free plan has a small CPU allowance. PageSpeed itself runs on Google's infrastructure, but parsing a Lighthouse response still consumes Worker CPU. SpeedPulse requests a partial PageSpeed response and processes only one due target per 5-minute cron invocation. That spreads work across the day instead of creating large bursts.

At the default schedule, theoretical scheduler capacity is up to 288 due tests/day. Actual capacity also depends on Google API quota, Cloudflare limits, test duration, errors, and your account limits.

## Data model

### projects
Groups related websites.

### sites
Stores the monitored URL, origin, active state, mobile/desktop frequency, next due timestamp, and latest run status/error.

### test_runs
One row per PageSpeed attempt. Failed attempts are retained rather than erased.

### metrics
One immutable historical snapshot per successful test.

### site_latest
A denormalized latest snapshot per site + strategy. This keeps dashboard reads inexpensive as history grows.

### annotations
Human notes such as "enabled cache" or "removed unused JS" so changes can be correlated with the chart timeline.

## Monitoring cadence

Default per site:

- Mobile: daily
- Desktop: weekly
- Cron trigger: every 5 minutes
- Batch size: 1 due test per cron
- Scheduled failure retry: 6 hours
- Manual tests: immediate and do not shift the normal schedule

You can change `SCHEDULE_BATCH_SIZE` in `wrangler.jsonc` from 1 to at most 3 in this codebase, but 1 is intentionally conservative for the free Worker CPU limit.

## Security

The Google API key is stored as the Cloudflare secret `GOOGLE_API_KEY` and is never returned by the API or frontend.

The dashboard is protected with:

- `ADMIN_PASSWORD` Worker secret
- `SESSION_SECRET` Worker secret
- signed HttpOnly cookie
- Secure cookie flag
- SameSite=Strict
- 7-day session expiry

This is designed as a private single-admin tool, not a multi-tenant SaaS authentication system.

## Field vs lab data

Lighthouse values are lab measurements from the PageSpeed Insights API.

Core Web Vitals are fetched separately from the Chrome UX Report API at origin level and stored as field data:

- LCP
- INP
- CLS

A low-traffic site can legitimately have no CrUX record. In that case field metrics remain NULL and the UI says "No field data"; Lighthouse history still works.
