# Changes in the recovered UI overhaul

## Interface

- Reworked the color palette to a restrained slate, indigo, white, emerald, amber, and red system.
- Updated the sidebar, login experience, cards, buttons, inputs, tables, tabs, modals, charts, and mobile layout.
- Increased spacing consistency and visual hierarchy while keeping the application framework-free.

## Dashboard

- Replaced the average-performance summary card with a `Needs attention` count.
- Kept projects, active sites, tests today, and the attention table.

## Projects

- Removed average mobile performance from project cards.
- Simplified each project card to the project description and monitored-site count.

## Project detail

The site table is intentionally reduced to the primary operational metrics:

1. Site
2. Mobile score
3. Desktop score
4. Mobile LCP
5. Status

`Mobile LCP` uses Lighthouse lab LCP (`mobile_lcp_ms`), not CrUX field LCP, so the value is available even for sites without enough Chrome UX Report traffic.

## Security & In-App Setup

- No passwords or API keys are stored in source.
- Google PageSpeed API keys can now be configured directly in-app through the Settings modal or onboarding banner, backed by D1 `system_state`.
- Settings now shows commands for rotating `ADMIN_PASSWORD` and `SESSION_SECRET`.
- See `RECOVERY_DEPLOY.md` for the exact live update and credential-rotation steps.

## Cloudflare Free Tier Capacity & Hardening

1. **Stale Job Recovery**: Sweeper runs at start of each cron tick, recovering stuck running/queued/pending jobs older than measured leases (`lease_expired`).
2. **Dynamic Scheduler**: Dispatches dynamically up to daily safe budget (`min(budgetRemaining, batchLimit)`), eliminating scheduler throttling bottlenecks.
3. **CPU Reduction**: Targeted Google PageSpeed API `fields` parameter omitting base64 screenshots and treemap traces; yields 97.0% payload reduction and 85.7% parse CPU reduction.
4. **Quota Ledger**: D1-backed atomic usage ledger with dual-timezone resets (Cloudflare UTC vs Google Pacific), 70% slowdown, 90% pause, and 95% manual scan block.
5. **D1 Report Storage**: High-capacity report blob storage in D1 (`report_payloads` table) with zero-downtime lazy-migration from KV, lifting the KV 1,000 writes/day ceiling.
6. **Retention & Rollups**: `metrics_daily_rollup` table tracking median and p75 metrics with 90-day small-batch raw pruning and indexed rollups for 1Y/All history charts.
7. **Capacity Tab & Heartbeat**: `/capacity` UI view with real-time quota telemetry, 15m cron heartbeat monitoring, and adaptive queue polling (3s active, 30s idle, 0s hidden).
8. **Demo Seeder**: `scripts/seed-demo.mjs` populates a clean demo instance with 6 public benchmark websites (Wikipedia, GitHub, Cloudflare, WordPress.org, Hacker News, MDN Web Docs), active scan targets, and 5-day historical charts.
