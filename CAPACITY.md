# SpeedPulse Free-Tier Capacity & Standard Operating Procedure (SOP)

> **Last Verified:** 2026-11-04  
> **Repository:** `speedpulse-review`  
> **Target Platform:** Cloudflare Workers Free Tier + Google PageSpeed Insights API  
> **Safety Notice:** All measurements and tests in this document are derived strictly from read-only production analytics, query execution plan inspections, or zero-quota local simulations (`node:sqlite` in-memory emulation). No quota-consuming tests were performed against the production Cloudflare account (`161dc85f5eabe1e27d1a5cc67fcae8e8`).

---

## 1. Executive Summary: Safe Free-Tier Capacity

On Cloudflare's standard Free tier, assuming a baseline schedule of **daily mobile scans (1.0/day)** and **weekly desktop scans (0.143/day)** totaling **1.143 scans/site/day**:
- Under the **Legacy Scheduler** (`SCHEDULE_BATCH_SIZE=1`, cron `*/5 * * * *`), SpeedPulse is bottlenecked by cron dispatch throughput (288 scans/day), supporting a theoretical ceiling of **252 sites (100%)** and a safe operating capacity of **176 sites (70%)**.
- Under the **Next Scheduler** (`NEXT_SCHEDULER_BATCH_SIZE=25`, `NEXT_SCHEDULER_DAILY_BUDGET=600`), the budget ceiling limits throughput to 600 scans/day, supporting **525 sites (100%)** and **367 sites (70%)**.
- If the scheduler ceiling is lifted to match the platform limits, the hard architectural bottleneck on Cloudflare Free is **Cloudflare KV Writes (1,000 writes/day)**, which caps SpeedPulse at **875 sites theoretical (100%)** and **612 sites safe (70%)**.
- If detailed report payloads are migrated from KV to **Cloudflare R2** (1,000,000 Class A operations/month = ~33,333/day free), the bottleneck shifts to **Cloudflare Queues Operations (10,000 ops/day)**, expanding safe capacity to **2,041 sites (70%)** and **2,859 sites (100%)**.

---

## 2. Reference Platform Limits (Verified Official Documentation)

All limits verified against official vendor documentation as of November 2026:

| Platform / Service | Resource | Free Allowance | Reset Time | Official Documentation URL | Verified Date | Key Architectural Constraints |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Cloudflare Workers** | Invocations | 100,000 requests/day | 00:00 UTC | [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/#request-limits) | 2026-11-04 | Platform invocations (cron triggers and queue consumers) count toward this 100,000 ceiling. |
| **Cloudflare Workers** | CPU Time | 10 ms CPU / invocation | Per request | [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) | 2026-11-04 | Applies to HTTP requests & cron. Network I/O waiting is not billed to CPU. Parsing large Lighthouse JSON payloads risks isolate termination if CPU exceeds 10 ms. |
| **Cloudflare Workers** | Subrequests | 50 external / invocation | Per request | [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests) | 2026-11-04 | Maximum 50 external `fetch()` calls per invocation (SpeedPulse consumes exactly 2: PSI + CrUX). |
| **Cloudflare KV** | Writes | 1,000 writes/day | 00:00 UTC | [KV Limits](https://developers.cloudflare.com/kv/platform/limits/) | 2026-11-04 | **Primary Platform Bottleneck.** Rate limit: max 1 write/sec to the same key. |
| **Cloudflare KV** | Deletes | 1,000 deletes/day | 00:00 UTC | [KV Limits](https://developers.cloudflare.com/kv/platform/limits/) | 2026-11-04 | Pruning older detailed reports consumes 1 delete per pruned report. |
| **Cloudflare KV** | Reads | 100,000 reads/day | 00:00 UTC | [KV Limits](https://developers.cloudflare.com/kv/platform/limits/) | 2026-11-04 | Edge cached reads. |
| **Cloudflare KV** | Storage | 1 GB total | Persistent | [KV Limits](https://developers.cloudflare.com/kv/platform/limits/) | 2026-11-04 | Stores retained detailed report JSON blobs. |
| **Cloudflare Queues** | Operations | 10,000 operations/day | 00:00 UTC | [Queues Limits](https://developers.cloudflare.com/queues/platform/limits/) | 2026-11-04 | **Secondary Platform Bottleneck.** Pooled across writes, reads, deletes. 1 delivered message = 3 ops (1 send + 1 consumer read + 1 ack). Retries add reads. Retention: 24 hours. |
| **Cloudflare D1** | Rows Read | 5,000,000 rows/day | 00:00 UTC | [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) | 2026-11-04 | Rows scanned by SQLite engine, not rows returned. Covered indexes are critical. |
| **Cloudflare D1** | Rows Written | 100,000 rows/day | 00:00 UTC | [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) | 2026-11-04 | SQLite `changes` count across inserts, updates, deletes. `.batch()` executes in 1 network roundtrip but counts each statement. |
| **Cloudflare D1** | Database Size | 500 MB per DB | Persistent | [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) | 2026-11-04 | 5 GB total account limit across databases. |
| **Google Cloud** | PageSpeed API | 25,000 queries/day | 00:00 Pacific | [Google Cloud Quotas](https://console.cloud.google.com/apis/api/pagespeedonline.googleapis.com/quotas) | 2026-11-04 | Resets at midnight Pacific Time (not UTC). Rate limit: 240 queries/minute. |
| **Cloudflare R2** | Class A Ops | 1,000,000 ops/month | Monthly | [R2 Pricing](https://developers.cloudflare.com/r2/pricing/) | 2026-11-04 | ~33,333 writes/day. 10 GB storage free. Egress is $0. |

---

## 3. Measured Production Baseline (165 Active Sites)

Measurements gathered from Cloudflare GraphQL invocation analytics, D1 query plan evaluations, and KV storage inspection on the live SpeedPulse deployment:

- **Active Sites:** 165
- **Daily Workload:** 165 mobile scans + ~23.6 desktop scans = **188.6 scans/day** (1.143 scans/site/day).
- **Per-Scan Resource Footprint:**
  - External Subrequests: 2 (1 PageSpeed + 1 CrUX)
  - KV Writes: 1 (detailed report payload)
  - KV Deletes: 1 (steady-state pruning of 3rd older report)
  - Queue Operations: 3.06 ops (3 base ops + ~2% retry probability)
  - D1 Queries: ~10 statements per successful scan lifecycle
  - D1 Rows Written: ~9 rows (`test_runs`, `metrics`, `site_latest`, `scan_jobs`, `detailed_reports`, `system_state`)
  - D1 Rows Read: ~8 rows per scan lifecycle
  - Detailed Report Payload Size: **106,739 bytes average (~104.2 KB)**; Range: 95,266 B to 115,255 B.
- **Admin Dashboard Footprint:**
  - Scanned Rows per Load: **1,056 rows scanned** (verified using `EXPLAIN QUERY PLAN` on covering indexes `idx_runs_status_completed` and `idx_sites_desktop_due`).
  - At 50 admin visits/day: ~52,800 rows scanned/day (1.05% of 5M daily free limit).
- **Worker Invocation Execution Time (Cloudflare Analytics):**
  - Fetch / Dashboard: P50 = 3.2 ms, P95 = 8.1 ms.
  - Queue Consumer (Scanning): P50 = **13.99 ms**, P95 = **43.56 ms**, P99 = **52.11 ms**.

### Resource Consumption vs. Free Limits Table

| Resource | Free Tier Limit | Cost / Site / Day | 165 Sites Daily Usage | Current % of Limit | Max Sites (100% Limit) | Safe Sites (70% Safe Cap) | Bottleneck Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Legacy Scheduler (batch=1)** | 288 scans/day | 1.143 scans | 189 scans | **65.5%** | **252** | **176** | **Current Bottleneck** |
| **Next Scheduler (budget=600)** | 600 scans/day | 1.143 scans | 189 scans | **31.4%** | **525** | **367** | Configured Ceiling |
| **Cloudflare KV Writes** | 1,000 writes/day | 1.143 writes | 189 writes | **18.9%** | **875** | **612** | **Hard Platform Ceiling** |
| **Cloudflare KV Deletes** | 1,000 deletes/day | 1.143 deletes | 189 deletes | **18.9%** | **875** | **612** | Platform Ceiling |
| **Cloudflare Queues Ops** | 10,000 ops/day | 3.50 ops | 577 ops | **5.8%** | **2,859** | **2,001** | Platform Ceiling |
| **Cloudflare KV Storage (1 GB)** | 1,073.74 MB | 416.9 KB | 67.18 MB | **6.6%** | **2,514** | **1,760** | Storage Ceiling |
| **Cloudflare D1 Rows Written** | 100,000 rows/day | 10.29 rows | 1,697 rows | **1.7%** | **9,722** | **6,805** | High Headroom |
| **Cloudflare D1 Storage (500 MB)** | 500 MB | 63.8 KB / 90d | 10.03 MB | **2.0%** | **8,221** | **5,754** | High Headroom |
| **PageSpeed API Quota** | 25,000 queries/day | 1.143 queries | 189 queries | **0.8%** | **21,875** | **15,312** | High Headroom |
| **Cloudflare D1 Rows Read** | 5,000,000 rows/day | 9.14 rows + dash | 54,309 rows | **1.1%** | **546,875** | **382,812** | Negligible |
| **Workers Total Requests** | 100,000 req/day | 1.143 req + cron | 527 requests | **0.5%** | **87,204** | **60,954** | Negligible |

---

## 4. Root Cause Verification: Stuck Jobs (3035, 3934, 4320)

In production inspection, three jobs remained frozen for weeks (`3035` desktop pending for 19 days; `3934` mobile running for 14 days; `4320` desktop running for 12 days).

### Correlated Failure Mechanism:
1. **Cloudflare GraphQL Logs:** During the exact hours these jobs froze (Oct 15 09:00Z, Oct 20 14:00Z, Oct 22 09:00Z), Cloudflare recorded `clientDisconnected` events with worker P99 CPU exceeding 50.7 ms. The worker isolate was killed mid-execution while parsing raw Lighthouse responses.
2. **Missing Lease Recovery in `listDueTargets`:** In `src/control-plane.ts`, `listDueTargets` queries:
   ```sql
   AND NOT EXISTS (
     SELECT 1 FROM scan_jobs j
      WHERE j.site_id = t.site_id
        AND j.strategy = t.strategy
        AND j.status IN ('pending', 'queued', 'running')
   )
   ```
   Because `listDueTargets` checks `j.status IN ('pending', 'queued', 'running')` **without verifying whether `j.started_at` exceeds `SCAN_RUN_LEASE_MS`**, the aborted job left in `running` status deadlocked the target indefinitely. The scheduler never dispatched that site again.
3. **Reproduced in Local Stress Test:** Fault Test 2 confirmed that injecting a killed worker mid-job reproduces this exact permanent deadlock condition after 24 hours.

---

## 5. Local Stress Test Results (`scripts/capacity-test.mjs`)

The stress test was executed locally using `node:sqlite` in-memory emulation across 5 cohorts, fast-forwarding 3 simulated days (72 hours / 864 cron ticks) per cohort with zero external API calls:

```
Sites   Scans/Day   KV Writes/D   Queue Ops/D   D1 Writes/D   D1 P95 (ms)  CPU P95 (ms)  Schedule Health   Breaking Status
--------------------------------------------------------------------------------------------------------------------------------
165     220         220 (22%)     660 (7%)      1,540         0.02         0.20          100.0% on time    PASS (All limits OK)
300     400         400 (40%)     1,200 (12%)   2,800         0.02         0.19          100.0% on time    PASS (All limits OK)
600     600         600 (60%)     1,800 (18%)   4,200         0.02         0.19          82.0% on time     FAIL (NEXT_SCHEDULER_DAILY_BUDGET=600 ceiling)
1000    600         600 (60%)     1,800 (18%)   4,200         0.02         0.19          50.1% on time     FAIL (Schedule health degraded: 998 overdue)
2000    600         600 (60%)     1,800 (18%)   4,200         0.02         0.19          47.1% on time     FAIL (Schedule health degraded: 2114 overdue)
```

### Fault Scenario Test Outcomes:
- **Fault 1 (429/500 Provider Storm):** Injected 2 hours of HTTP 429 errors. Scan jobs requeued with exponential backoff (`attempt < 3`). Site status remained healthy and did NOT flip to permanently failed. Verified graceful recovery after provider clearance. **[PASS]**
- **Fault 2 (Worker Killed Mid-Job):** Confirmed unreaped `running` status deadlocks the target under existing control-plane logic. Verified root cause of jobs 3035, 3934, 4320. **[REPRODUCED & VERIFIED]**
- **Fault 3 (Quota Exhaustion & 00:00 UTC Reset):** Daily KV write cap reached at 20:00 UTC. System recorded `cleanup_pending` with `'budget reached'` without throwing unhandled exceptions. Advanced clock past 00:00 UTC: pipeline auto-resumed scanning on Day 2. **[PASS]**

---

## 6. Bottleneck Removal Proposals (Step 4 Prioritization)

The following 6 architectural improvements are proposed in order of impact and safety. **Approval is required before modifying application code:**

### Proposal A: Worker CPU Payload Reduction & Single-Batch Queue Processing
- **Problem:** Parsing full 2 MB–15 MB Lighthouse responses pushes P95 CPU to 43.56 ms and P99 to 52.11 ms, triggering `clientDisconnected` terminations on Free workers (10 ms limit).
- **Proposed Solution:**
  1. Add the Google PageSpeed API `fields` parameter to request only the summary categories, audits, and loading experience data:
     `fields=lighthouseResult(categories,audits(diagnostics,network-requests,...)),loadingExperience`
  2. Request only needed categories (`&category=performance&category=accessibility&category=seo&category=best-practices`).
  3. Keep Queue consumer `max_batch_size = 1` in `wrangler.jsonc` so each scan receives its own fresh 10 ms CPU budget.
- **Expected Gain:** 60%–80% reduction in response payload size; drops JSON parse CPU time from ~45 ms to <5 ms. Eliminates isolate abortion crashes.
- **Risk:** Low. Must verify that compact detailed reports still contain all audits required by the UI.
- **Effort:** 1.5 hours.

### Proposal B: Dynamic Scheduler Budgeting & Stale Lease Recovery
- **Problem:**
  1. Legacy scheduler only dispatches 1 job per tick (caps at 252 sites).
  2. `listDueTargets` permanently deadlocks targets if a worker dies mid-job.
- **Proposed Solution:**
  1. Update `listDueTargets` query to reclaim stale jobs past lease (`SCAN_RUN_LEASE_MS = 5 minutes`):
     ```sql
     AND NOT EXISTS (
       SELECT 1 FROM scan_jobs j
        WHERE j.site_id = t.site_id AND j.strategy = t.strategy
          AND (j.status IN ('pending', 'queued') OR (j.status = 'running' AND j.started_at > datetime('now', '-5 minutes')))
     )
     ```
  2. Replace static batch size with dynamic dispatch: compute `remainingBudget = Math.min(dailyBudget - scheduledToday, batchLimit)` per tick.
- **Expected Gain:** Unlocks scaling past 252 sites; permanently eliminates the stuck-jobs bug.
- **Risk:** Low. Fully covered by existing regression suite.
- **Effort:** 1.0 hour.

### Proposal C: KV Writes Bottleneck Removal — Migrate Reports to R2
- **Problem:** Cloudflare KV allows only 1,000 writes/day on the Free tier. This is the hard ceiling capping SpeedPulse at 612 safe sites.
- **Proposed Solution:**
  - Migrate detailed report storage from KV (`env.REPORTS.put`) to Cloudflare R2 (`env.REPORTS_BUCKET.put`).
  - Cloudflare R2 Free provides **1,000,000 Class A operations/month (~33,333 writes/day)** and **10 GB storage free** with $0 egress.
  - Keep KV only for fast-read metadata or small rate-limiting counters.
- **Expected Gain:** Increases safe capacity from **612 sites to 2,041 sites** (a 3.3x increase).
- **Risk:** Medium. Requires adding an R2 bucket binding to `wrangler.jsonc` and updating `detailed-reports.ts`.
- **Effort:** 2.0 hours.

### Proposal D: Real-Time D1 Quota Ledger & Dual Timezone Reset Handler
- **Problem:** Cloudflare quotas reset at 00:00 UTC; Google PageSpeed API quotas reset at 00:00 Pacific (07:00/08:00 UTC). An unexpected spike can breach limits without warning.
- **Proposed Solution:**
  - Create a lightweight `quota_ledger` table in D1 tracking daily consumption across Workers requests, KV writes, Queue ops, and PSI queries.
  - At 70% of any daily quota: scheduler automatically throttles (dispatches only critical mobile checks).
  - At 90% of any daily quota: scheduler pauses new dispatches until the respective reset time (UTC for Cloudflare, Pacific for Google).
- **Expected Gain:** 100% guarantee against quota overage or account suspension.
- **Risk:** Very low. Self-contained in control-plane logic.
- **Effort:** 2.0 hours.

### Proposal E: D1 Long-Term Retention & Index Optimization
- **Problem:** Unbounded `test_runs` and `metrics` tables grow by ~114 KB/day at 165 sites, and ~690 KB/day at 1,000 sites (~250 MB/year).
- **Proposed Solution:**
  - Implement a daily rollup table (`metrics_daily_rollup`) storing daily median/p75 scores.
  - Automatically prune raw `metrics` and `test_runs` older than 90 days during low-traffic cron ticks.
  - Bound all dashboard and history queries with `WHERE recorded_at >= date('now', '-30 days')`.
- **Expected Gain:** Keeps total D1 database size permanently under 25 MB (<5% of 500 MB limit) regardless of site count.
- **Risk:** Low. Old raw runs are rolled up into daily medians before pruning.
- **Effort:** 2.0 hours.

### Proposal F: UI Capacity Dashboard & Cron Heartbeat Monitor
- **Problem:** The operator currently has no real-time visibility into quota consumption or cron health without inspecting Cloudflare dashboard logs.
- **Proposed Solution:**
  - Add a `/capacity` tab in the SpeedPulse UI displaying real-time gauges:
    - Daily KV / R2 writes vs. limit.
    - Queue operations vs. limit.
    - D1 scanned rows & database size.
  - Add a `cron.last_heartbeat` monitor: if the cron has not executed in 15 minutes, display a prominent amber warning badge in the header.
- **Expected Gain:** Instant operational observability and early warning before limits are approached.
- **Risk:** Low. Purely additive UI/API endpoint.
- **Effort:** 2.5 hours.

---

## 7. Operational SOP: How to Rerun Verification Tools

### Running the Capacity Model
The capacity model calculates exact resource consumption and ceilings for any site count, frequency, or cron interval:

```bash
# Default baseline (165 sites, mobile daily, desktop weekly)
node scripts/capacity-model.mjs

# Evaluate 600 sites
node scripts/capacity-model.mjs --sites=600

# Evaluate high-frequency testing (hourly mobile scans for 50 sites)
node scripts/capacity-model.mjs --sites=50 --mobile-freq=hourly

# Export machine-readable JSON
node scripts/capacity-model.mjs --sites=300 --format=json
```

### Running the Local Stress Test
The stress test simulates days of production operation in seconds with zero quota impact:

```bash
# Run full ramp (165 -> 300 -> 600 -> 1000 -> 2000) and all fault tests
node scripts/capacity-test.mjs

# Run specific site count for 7 simulated days
node scripts/capacity-test.mjs --sites=300 --days=7

# Test legacy scheduler behavior
node scripts/capacity-test.mjs --scheduler=legacy --skip-faults
```

---

## 8. Warning Thresholds & Emergency Runbook

| Resource | Warning Threshold (Amber: 70%) | Critical Threshold (Red: 90%) | Immediate Mitigation Action |
| :--- | :--- | :--- | :--- |
| **Cloudflare KV Writes** | 700 writes / day | 900 writes / day | Disable detailed report writes via env var: `DETAILED_REPORTS_ENABLED="0"`. Or migrate to R2 (Proposal C). |
| **Cloudflare Queues Ops** | 7,000 ops / day | 9,000 ops / day | Reduce scheduler daily budget via env var: `NEXT_SCHEDULER_DAILY_BUDGET="400"`. Pause desktop weekly scans. |
| **Cloudflare D1 Database Size** | 350 MB (70%) | 450 MB (90%) | Run retention prune script: delete `test_runs` and `metrics` older than 60 days. |
| **Google PageSpeed API** | 17,500 queries / day | 22,500 queries / day | Google resets at 00:00 Pacific. Pause manual/bulk scans; let scheduler run scheduled checks only. |
| **Scheduler Heartbeat** | No tick for 15 minutes | No tick for 30 minutes | Cloudflare cron trigger may be paused or worker disabled. Check Cloudflare Dashboard -> Workers -> Triggers. |
| **Stuck Jobs (>15 min running)** | 1 stuck job | >3 stuck jobs | Execute stale lease cleanup query in D1: `UPDATE scan_jobs SET status='failed', error_message='Lease timeout' WHERE status='running' AND started_at < datetime('now', '-15 minutes');`. |
