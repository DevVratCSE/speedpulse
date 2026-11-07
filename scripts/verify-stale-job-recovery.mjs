#!/usr/bin/env node

/**
 * Automated Verification: Stale Job Recovery & Queue Lease Safety
 *
 * Verifies Item 1 Requirements:
 * 1. Crash mid-run: 'running' job older than run lease (5 min) is marked 'failed' (error_class = 'lease_expired').
 * 2. Stuck pending: 'pending' job older than dispatch lease (15 min) is marked 'failed' (error_class = 'lease_expired').
 * 3. Stuck queued: 'queued' job older than dispatch lease (15 min) is marked 'failed' (error_class = 'lease_expired').
 * 4. Idempotent claiming: late message for expired job is safely acked without duplicate execution.
 * 5. Legitimate active scan within lease is NOT touched.
 * 6. Scheduler is unblocked immediately after sweep (due targets query returns target).
 * 7. Swept jobs appear in failedJobs24h and recentJobs in the Queue UI.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import esbuild from "esbuild";

// -----------------------------------------------------------------------------
// Compile TypeScript sources into memory for direct unit execution
// -----------------------------------------------------------------------------
const bundle = esbuild.buildSync({
  stdin: {
    contents: `
      export * from "./src/control-plane";
      export * from "./src/scan-policy";
      export * from "./src/queue";
      export * from "./src/scheduler";
    `,
    resolveDir: process.cwd(),
    sourcefile: "virtual-entry.ts",
    loader: "ts"
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false
});

const tempModulePath = path.resolve(process.cwd(), ".verify-stale-bundle.mjs");
fs.writeFileSync(tempModulePath, bundle.outputFiles[0].text);

let mod;
try {
  mod = await import(tempModulePath);
} finally {
  try {
    fs.unlinkSync(tempModulePath);
  } catch {}
}

const {
  sweepStaleJobs,
  SCAN_RUN_LEASE_MS,
  SCAN_DISPATCH_LEASE_MS,
  claimScanJob,
  listDueTargets,
  getSystemHealth,
  getQueueWorkspace
} = mod;

// -----------------------------------------------------------------------------
// In-Memory SQLite D1 Mock
// -----------------------------------------------------------------------------
function createTestD1() {
  const rawDb = new DatabaseSync(":memory:");
  rawDb.exec("PRAGMA foreign_keys = OFF;");

  const migrationFiles = [
    "0001_init.sql",
    "0002_run_safety.sql",
    "0003_next_control_plane.sql",
    "0004_custom_schedules.sql",
    "0005_control_plane_convergence.sql",
    "0006_detailed_reports.sql",
    "0007_quota_ledger.sql",
    "0008_d1_report_storage.sql",
    "0009_metrics_daily_rollup.sql"
  ];

  for (const f of migrationFiles) {
    const sql = fs.readFileSync(path.join(process.cwd(), "migrations", f), "utf8");
    rawDb.exec(sql);
  }

  rawDb.exec("INSERT OR IGNORE INTO projects (id, name, description) VALUES (1, 'Test', 'Test');");
  rawDb.exec("INSERT OR IGNORE INTO sites (id, project_id, name, url, origin, active, mobile_frequency, desktop_frequency, created_at, updated_at) VALUES (1, 1, 'Site 1', 'https://example.com', 'example.com', 1, 'daily', 'weekly', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');");
  rawDb.exec("INSERT OR IGNORE INTO sites (id, project_id, name, url, origin, active, mobile_frequency, desktop_frequency, created_at, updated_at) VALUES (2, 1, 'Site 2', 'https://example.org', 'example.org', 1, 'daily', 'weekly', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');");
  rawDb.exec("INSERT OR IGNORE INTO sites (id, project_id, name, url, origin, active, mobile_frequency, desktop_frequency, created_at, updated_at) VALUES (3, 1, 'Site 3', 'https://example.net', 'example.net', 1, 'daily', 'weekly', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');");

  // D1 wrapper
  const d1 = {
    prepare(sql) {
      const stmt = rawDb.prepare(sql);
      return {
        _params: [],
        bind(...params) {
          this._params = params;
          return this;
        },
        first(col) {
          const row = stmt.get(...this._params);
          if (!row) return null;
          if (col && typeof col === "string") return row[col] !== undefined ? row[col] : null;
          return row;
        },
        all() {
          const rows = stmt.all(...this._params);
          return Promise.resolve({ results: rows, meta: { changes: 0 } });
        },
        run() {
          if (sql.trim().toUpperCase().startsWith("SELECT")) {
            const rows = stmt.all(...this._params);
            return Promise.resolve({
              results: rows,
              meta: { changes: 0, last_row_id: 0 }
            });
          }
          const res = stmt.run(...this._params);
          return Promise.resolve({
            results: [],
            meta: {
              changes: Number(res.changes || 0),
              last_row_id: Number(res.lastInsertRowid || 0)
            }
          });
        }
      };
    },
    async batch(statements) {
      rawDb.exec("BEGIN TRANSACTION;");
      try {
        const results = await Promise.all(statements.map(s => s.run()));
        rawDb.exec("COMMIT;");
        return results;
      } catch (e) {
        rawDb.exec("ROLLBACK;");
        throw e;
      }
    },
    raw: rawDb
  };

  return d1;
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`TEST FAILED: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}

async function runTests() {
  console.log("==================================================================");
  console.log("  RUNNING ITEM 1: STALE JOB RECOVERY TESTS");
  console.log("==================================================================");

  assert(typeof sweepStaleJobs === "function", "sweepStaleJobs function is exported from control-plane");
  assert(SCAN_RUN_LEASE_MS === 5 * 60 * 1000, "SCAN_RUN_LEASE_MS is defined at 5 minutes (300,000 ms)");
  assert(SCAN_DISPATCH_LEASE_MS === 15 * 60 * 1000, "SCAN_DISPATCH_LEASE_MS is defined at 15 minutes (900,000 ms)");

  const d1 = createTestD1();
  const now = new Date("2026-11-04T12:00:00.000Z");
  const nowIso = now.toISOString();

  // Test 1: Crash mid-run (running older than 5 min)
  console.log("\n[Test 1] Crash mid-run: running older than run lease (5 min)");
  {
    const d1 = createTestD1();
    const startedAt = new Date(now.getTime() - (6 * 60 * 1000)).toISOString(); // 6m ago
    d1.raw.prepare(`
      INSERT INTO scan_jobs (id, site_id, strategy, trigger, status, attempt, started_at, created_at, updated_at)
      VALUES (101, 1, 'mobile', 'scheduled', 'running', 1, ?, ?, ?)
    `).run(startedAt, startedAt, startedAt);

    const sweepResult = await sweepStaleJobs(d1, nowIso);
    const job = d1.raw.prepare("SELECT * FROM scan_jobs WHERE id = 101").get();

    assert(job.status === "failed", "Job status is transitioned to 'failed'");
    assert(job.error_class === "lease_expired", "Job error_class is set to 'lease_expired'");
    assert(job.completed_at === nowIso, "Job completed_at is set to current timestamp");
    assert(sweepResult.swept >= 1, "sweepStaleJobs returns swept count");
  }

  // Test 2: Stuck pending (pending older than 15 min)
  console.log("\n[Test 2] Stuck pending: pending older than dispatch lease (15 min)");
  {
    const d1 = createTestD1();
    const createdAt = new Date(now.getTime() - (20 * 60 * 1000)).toISOString(); // 20m ago
    d1.raw.prepare(`
      INSERT INTO scan_jobs (id, site_id, strategy, trigger, status, attempt, created_at, updated_at)
      VALUES (102, 1, 'mobile', 'scheduled', 'pending', 0, ?, ?)
    `).run(createdAt, createdAt);

    await sweepStaleJobs(d1, nowIso);
    const job = d1.raw.prepare("SELECT * FROM scan_jobs WHERE id = 102").get();

    assert(job.status === "failed", "Stuck pending job is marked 'failed'");
    assert(job.error_class === "lease_expired", "Stuck pending job error_class is 'lease_expired'");
  }

  // Test 3: Stuck queued (queued older than 15 min)
  console.log("\n[Test 3] Stuck queued: queued older than dispatch lease (15 min)");
  {
    const d1 = createTestD1();
    const queuedAt = new Date(now.getTime() - (18 * 60 * 1000)).toISOString(); // 18m ago
    d1.raw.prepare(`
      INSERT INTO scan_jobs (id, site_id, strategy, trigger, status, attempt, queued_at, created_at, updated_at)
      VALUES (103, 1, 'desktop', 'scheduled', 'queued', 0, ?, ?, ?)
    `).run(queuedAt, queuedAt, queuedAt);

    await sweepStaleJobs(d1, nowIso);
    const job = d1.raw.prepare("SELECT * FROM scan_jobs WHERE id = 103").get();

    assert(job.status === "failed", "Stuck queued job is marked 'failed'");
    assert(job.error_class === "lease_expired", "Stuck queued job error_class is 'lease_expired'");
  }

  // Test 4: Idempotent claiming (late message for expired job cannot claim or run)
  console.log("\n[Test 4] Idempotent claiming: late queue delivery after expiry");
  {
    const d1 = createTestD1();
    const startedAt = new Date(now.getTime() - (6 * 60 * 1000)).toISOString(); // 6m ago
    d1.raw.prepare(`
      INSERT INTO scan_jobs (id, site_id, strategy, trigger, status, attempt, started_at, created_at, updated_at)
      VALUES (104, 1, 'mobile', 'scheduled', 'running', 1, ?, ?, ?)
    `).run(startedAt, startedAt, startedAt);

    await sweepStaleJobs(d1, nowIso);

    // Job 104 is now 'failed' with 'lease_expired'
    const claim = await claimScanJob(d1, 104, nowIso);
    assert(claim.claimed === false, "claimScanJob returns claimed: false for expired job");

    const job = d1.raw.prepare("SELECT * FROM scan_jobs WHERE id = 104").get();
    assert(job.status === "failed", "Job remains 'failed' (no transition back to running)");
  }

  // Test 5: Legitimate long scan within lease is NOT expired
  console.log("\n[Test 5] Legitimate long scan within lease is NOT expired");
  {
    const d1 = createTestD1();
    const runningValidAt = new Date(now.getTime() - (2 * 60 * 1000)).toISOString(); // 2m ago (<5m)
    const queuedValidAt = new Date(now.getTime() - (5 * 60 * 1000)).toISOString();  // 5m ago (<15m)
    const pendingValidAt = new Date(now.getTime() - (3 * 60 * 1000)).toISOString(); // 3m ago (<15m)

    d1.raw.prepare(`
      INSERT INTO scan_jobs (id, site_id, strategy, trigger, status, attempt, started_at, created_at, updated_at)
      VALUES (201, 1, 'mobile', 'scheduled', 'running', 1, ?, ?, ?)
    `).run(runningValidAt, runningValidAt, runningValidAt);

    d1.raw.prepare(`
      INSERT INTO scan_jobs (id, site_id, strategy, trigger, status, attempt, queued_at, created_at, updated_at)
      VALUES (202, 2, 'desktop', 'scheduled', 'queued', 0, ?, ?, ?)
    `).run(queuedValidAt, queuedValidAt, queuedValidAt);

    d1.raw.prepare(`
      INSERT INTO scan_jobs (id, site_id, strategy, trigger, status, attempt, created_at, updated_at)
      VALUES (203, 3, 'mobile', 'scheduled', 'pending', 0, ?, ?)
    `).run(pendingValidAt, pendingValidAt);

    await sweepStaleJobs(d1, nowIso);

    const jobRunning = d1.raw.prepare("SELECT status FROM scan_jobs WHERE id = 201").get();
    const jobQueued = d1.raw.prepare("SELECT status FROM scan_jobs WHERE id = 202").get();
    const jobPending = d1.raw.prepare("SELECT status FROM scan_jobs WHERE id = 203").get();

    assert(jobRunning.status === "running", "Active run at 2m is still 'running'");
    assert(jobQueued.status === "queued", "Queued job at 5m is still 'queued'");
    assert(jobPending.status === "pending", "Pending job at 3m is still 'pending'");
  }

  // Test 6: Scheduler unblocked after sweep
  console.log("\n[Test 6] Scheduler unblocked after sweep");
  {
    const d1 = createTestD1();
    // Site 1 mobile target is due in the past
    const pastDueAt = new Date(now.getTime() - (60 * 60 * 1000)).toISOString(); // 1h ago
    d1.raw.prepare(`
      UPDATE scan_targets
         SET next_due_at = ?, enabled = 1
       WHERE site_id = 1 AND strategy = 'mobile'
    `).run(pastDueAt);

    // Insert a stuck job that blocks Site 1 mobile
    const stuckTime = new Date(now.getTime() - (30 * 60 * 1000)).toISOString(); // 30m ago
    d1.raw.prepare(`
      INSERT INTO scan_jobs (id, site_id, strategy, trigger, status, attempt, started_at, created_at, updated_at)
      VALUES (301, 1, 'mobile', 'scheduled', 'running', 1, ?, ?, ?)
    `).run(stuckTime, stuckTime, stuckTime);

    // Query due targets BEFORE sweep
    const dueBefore = await listDueTargets(d1, 10, nowIso);
    const site1DueBefore = dueBefore.find(t => t.site_id === 1 && t.strategy === "mobile");
    assert(!site1DueBefore, "Site 1 mobile is blocked before sweep due to stuck job");

    // Run sweeper
    await sweepStaleJobs(d1, nowIso);

    // Query due targets AFTER sweep
    const dueAfter = await listDueTargets(d1, 10, nowIso);
    const site1DueAfter = dueAfter.find(t => t.site_id === 1 && t.strategy === "mobile");
    assert(Boolean(site1DueAfter), "Site 1 mobile is immediately unblocked after sweep");
  }

  // Test 7: Expired jobs appear in failedJobs24h and recentJobs in the Queue workspace UI
  console.log("\n[Test 7] Expired jobs appear in failedJobs24h and recentJobs");
  {
    const d1 = createTestD1();
    const startedAt = new Date(now.getTime() - (6 * 60 * 1000)).toISOString();
    d1.raw.prepare(`
      INSERT INTO scan_jobs (id, site_id, strategy, trigger, status, attempt, started_at, created_at, updated_at)
      VALUES (401, 1, 'mobile', 'scheduled', 'running', 1, ?, ?, ?)
    `).run(startedAt, startedAt, startedAt);

    await sweepStaleJobs(d1, nowIso);

    const health = await getSystemHealth(d1, nowIso);
    assert(health.counts.failedJobs24h >= 1, `failedJobs24h reflects swept jobs (count: ${health.counts.failedJobs24h})`);

    const queueWorkspace = await getQueueWorkspace(d1, 60, nowIso);
    assert(queueWorkspace.counts.failedJobs24h >= 1, `queueWorkspace.failedJobs24h reflects swept jobs (count: ${queueWorkspace.counts.failedJobs24h})`);

    const sweptJobInRecent = queueWorkspace.recentJobs.find(j => j.id === 401);
    assert(Boolean(sweptJobInRecent), "Swept job 401 appears in recentJobs in Queue UI");
    assert(sweptJobInRecent.error_class === "lease_expired", "Recent job error_class shows 'lease_expired'");
  }

  console.log("\n==================================================================");
  console.log("  ALL STALE JOB RECOVERY TESTS PASSED! (7/7)");
  console.log("==================================================================\n");
}

runTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
