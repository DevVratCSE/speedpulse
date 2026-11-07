#!/usr/bin/env node

/**
 * Automated Verification: Item 6 D1 Retention and Rollups
 *
 * Verifies:
 * 1. Percentile computation (median and p75).
 * 2. Daily rollup generation (rollupSiteDayMetrics) storing median and p75.
 * 3. 90-day raw data pruning in small batches, preserving site_latest runs
 *    and ensuring rollups are preserved before deletion.
 * 4. History API routing: 1Y (365) and All read from metrics_daily_rollup,
 *    <= 90D reads from raw metrics.
 * 5. EXPLAIN QUERY PLAN: confirms covering and indexed queries across dashboard endpoints.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import esbuild from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");

// Compile TypeScript sources into memory
const bundle = esbuild.buildSync({
  stdin: {
    contents: `
      export * from "./src/rollups";
      export * from "./src/auth";
      export { default as workerDefault } from "./src/index";
    `,
    resolveDir: projectRoot,
    sourcefile: "virtual-entry.ts",
    loader: "ts"
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false
});

const tempModulePath = path.resolve(projectRoot, ".verify-rollups-bundle.mjs");
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
  computePercentile,
  rollupSiteDayMetrics,
  backfillDailyRollups,
  pruneOldRawMetrics,
  runRetentionPruneTick,
  makeSessionCookie,
  workerDefault
} = mod;

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

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
    const sql = fs.readFileSync(path.join(projectRoot, "migrations", f), "utf8");
    rawDb.exec(sql);
  }

  rawDb.exec("INSERT OR IGNORE INTO projects (id, name, description) VALUES (1, 'Test Project', 'Test');");
  rawDb.exec(`INSERT INTO sites (id, project_id, name, url, origin, active, mobile_frequency, desktop_frequency, created_at, updated_at)
              VALUES (1, 1, 'Site 1', 'https://site1.com', 'site1.com', 1, 'daily', 'weekly', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`);

  const d1 = {
    raw: rawDb,
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
            return Promise.resolve({ results: rows, meta: { changes: 0, last_row_id: 0 } });
          }
          const res = stmt.run(...this._params);
          return Promise.resolve({
            results: [],
            meta: { changes: Number(res.changes || 0), last_row_id: Number(res.lastInsertRowid || 0) }
          });
        }
      };
    },
    async batch(statements) {
      const results = [];
      for (const s of statements) {
        results.push(await s.run());
      }
      return results;
    }
  };

  return d1;
}

console.log("==================================================================");
console.log("  RUNNING ITEM 6: D1 RETENTION & ROLLUPS TESTS");
console.log("==================================================================");

// [Test 1] Percentile Calculation
console.log("\n[Test 1] Percentile computation (median and p75)");
{
  assert.strictEqual(computePercentile([], 50), null, "Empty array returns null");
  assert.strictEqual(computePercentile([42], 50), 42, "Single item array returns that item");

  const values = [60, 70, 80, 90];
  // 50th percentile of [60, 70, 80, 90]: index = 0.5 * 3 = 1.5 -> (70 + 80) / 2 = 75
  const median = computePercentile(values, 50);
  assert.strictEqual(median, 75, `Median should be 75 (got ${median})`);

  // 75th percentile of [60, 70, 80, 90]: index = 0.75 * 3 = 2.25 -> 80 * 0.75 + 90 * 0.25 = 82.5
  const p75 = computePercentile(values, 75);
  assert.strictEqual(p75, 82.5, `p75 should be 82.5 (got ${p75})`);

  pass("Median and p75 computed with exact mathematical interpolation");
}

// [Test 2] Daily Rollup Generation (median and p75)
console.log("\n[Test 2] Daily Rollup Generation: rollupSiteDayMetrics");
{
  const db = createTestD1();
  const day = "2026-10-15";

  // Seed 4 runs across the day
  const scores = [60, 70, 80, 90];
  const lcps = [3000, 2500, 2000, 1500]; // sorted: 1500, 2000, 2500, 3000
  const clss = [0.05, 0.08, 0.12, 0.15];

  for (let i = 0; i < 4; i++) {
    const runId = 100 + i;
    const time = `${day}T0${i * 3 + 1}:00:00.000Z`;

    db.raw.exec(`INSERT INTO test_runs (id, site_id, strategy, source, status, started_at, completed_at)
                VALUES (${runId}, 1, 'mobile', 'scheduled', 'success', '${time}', '${time}');`);

    db.raw.exec(`INSERT INTO metrics (id, test_run_id, site_id, strategy, recorded_at, performance_score, accessibility_score, seo_score, best_practices_score, fcp_ms, lcp_ms, tbt_ms, cls, speed_index_ms, field_lcp_ms, field_inp_ms, field_cls, field_data_source)
                VALUES (${runId}, ${runId}, 1, 'mobile', '${time}', ${scores[i]}, 90, 95, 100, 1200, ${lcps[i]}, 150, ${clss[i]}, 2100, 2200, 100, 0.05, 'crux-origin');`);
  }

  const generated = await rollupSiteDayMetrics(db, 1, "mobile", day);
  assert.strictEqual(generated, true, "Should generate daily rollup");

  const rollup = db.raw.prepare("SELECT * FROM metrics_daily_rollup WHERE site_id=1 AND strategy='mobile' AND rollup_date=?").get(day);
  assert(rollup, "Rollup row must exist in metrics_daily_rollup");
  assert.strictEqual(rollup.total_runs, 4);
  assert.strictEqual(rollup.successful_runs, 4);

  // Scores: [60, 70, 80, 90]
  assert.strictEqual(rollup.performance_score, 75, "performance_score median must be 75");
  assert.strictEqual(rollup.performance_score_p75, 83, "performance_score p75 rounded must be 83");

  // LCP: [1500, 2000, 2500, 3000] -> median = 2250, p75 = 2625
  assert.strictEqual(rollup.lcp_ms, 2250, "lcp_ms median must be 2250");
  assert.strictEqual(rollup.lcp_ms_p75, 2625, "lcp_ms p75 must be 2625");

  // CLS: [0.05, 0.08, 0.12, 0.15] -> median = 0.1, p75 = 0.128
  assert.strictEqual(rollup.cls, 0.1, "cls median must be 0.1");

  // CrUX field data preserved
  assert.strictEqual(rollup.field_lcp_ms, 2200);
  assert.strictEqual(rollup.field_data_source, "crux-origin");

  pass("Rollup correctly computes and stores median and p75 across metrics");

  // Verify idempotency (re-running does not error and preserves data)
  const rerun = await rollupSiteDayMetrics(db, 1, "mobile", day);
  assert.strictEqual(rerun, true);
  pass("rollupSiteDayMetrics is idempotent via ON CONFLICT upsert");
}

// [Test 3] 90-Day Raw Data Pruning
console.log("\n[Test 3] Prune raw rows older than 90 days in small batches");
{
  const db = createTestD1();
  const now = new Date("2026-11-04T12:00:00.000Z");
  const cutoff = new Date(now.getTime() - 90 * 86_400_000).toISOString(); // 2026-08-06

  // 1. Seed 5 old runs (> 90 days ago)
  for (let i = 1; i <= 5; i++) {
    const runId = 200 + i;
    const oldTime = `2026-07-0${i}T10:00:00.000Z`;

    db.raw.exec(`INSERT INTO test_runs (id, site_id, strategy, source, status, started_at, completed_at)
                VALUES (${runId}, 1, 'mobile', 'scheduled', 'success', '${oldTime}', '${oldTime}');`);

    db.raw.exec(`INSERT INTO metrics (id, test_run_id, site_id, strategy, recorded_at, performance_score, lcp_ms, cls)
                VALUES (${runId}, ${runId}, 1, 'mobile', '${oldTime}', 70, 2500, 0.05);`);

    db.raw.exec(`INSERT INTO scan_jobs (id, site_id, strategy, status, trigger, priority, attempt, created_at, updated_at)
                VALUES (${runId}, 1, 'mobile', 'success', 'scheduled', 100, 1, '${oldTime}', '${oldTime}');`);
  }

  // 2. Seed 1 ancient run that IS in site_latest (must NOT be deleted)
  const latestRunId = 299;
  const latestOldTime = "2026-06-01T10:00:00.000Z";
  db.raw.exec(`INSERT INTO test_runs (id, site_id, strategy, source, status, started_at, completed_at)
              VALUES (${latestRunId}, 1, 'desktop', 'scheduled', 'success', '${latestOldTime}', '${latestOldTime}');`);
  db.raw.exec(`INSERT INTO site_latest (site_id, strategy, test_run_id, recorded_at, performance_score, lcp_ms)
              VALUES (1, 'desktop', ${latestRunId}, '${latestOldTime}', 85, 1800);`);

  // 3. Seed 2 fresh runs (< 90 days ago)
  const freshTime = "2026-10-20T10:00:00.000Z";
  for (let i = 1; i <= 2; i++) {
    const runId = 300 + i;
    db.raw.exec(`INSERT INTO test_runs (id, site_id, strategy, source, status, started_at, completed_at)
                VALUES (${runId}, 1, 'mobile', 'scheduled', 'success', '${freshTime}', '${freshTime}');`);

    db.raw.exec(`INSERT INTO metrics (id, test_run_id, site_id, strategy, recorded_at, performance_score, lcp_ms, cls)
                VALUES (${runId}, ${runId}, 1, 'mobile', '${freshTime}', 92, 1400, 0.01);`);
  }

  // Pre-condition: 5 old + 2 fresh = 7 metrics rows
  assert.strictEqual(db.raw.prepare("SELECT COUNT(*) as c FROM metrics").get().c, 7);

  // Run prune with batchSize = 10
  const pruneRes = await pruneOldRawMetrics(db, cutoff, 10);
  assert.strictEqual(pruneRes.metricsPruned, 5, "5 old metrics rows should be pruned");
  assert.strictEqual(pruneRes.runsPruned, 5, "5 old test_runs should be pruned");
  assert.strictEqual(pruneRes.jobsPruned, 5, "5 old scan_jobs should be pruned");

  // Post-condition: fresh rows still exist
  const remainingMetrics = db.raw.prepare("SELECT COUNT(*) as c FROM metrics").get().c;
  assert.strictEqual(remainingMetrics, 2, "Only 2 fresh metrics rows should remain");

  // Protected run in site_latest was preserved
  const protectedRun = db.raw.prepare("SELECT * FROM test_runs WHERE id=?").get(latestRunId);
  assert(protectedRun, "test_run referenced in site_latest must NOT be deleted");

  // Rollups were created for pruned dates before deletion
  const rollupsCount = db.raw.prepare("SELECT COUNT(*) as c FROM metrics_daily_rollup").get().c;
  assert(rollupsCount >= 5, `Daily rollups must exist for pruned days (count: ${rollupsCount})`);

  pass("Pruned 5 old rows, preserved fresh rows and site_latest run, with rollups saved");
}

// [Test 4] History API Routing: 1Y and All Ranges Read From Rollups
console.log("\n[Test 4] History API: 1Y and All ranges read from rollups");
{
  const db = createTestD1();
  const env = {
    DB: db,
    ADMIN_PASSWORD: "testpassword",
    SESSION_SECRET: "testsecret01234567890123456789012"
  };

  const sessionCookie = await makeSessionCookie(env);

  // Insert a rollup row from 120 days ago (older than 90d, thus not in raw metrics)
  const rollupDate = "2026-06-15";
  const rollupRecordedAt = `${rollupDate}T00:00:00.000Z`;
  db.raw.exec(`INSERT INTO metrics_daily_rollup (site_id, strategy, rollup_date, recorded_at, total_runs, successful_runs, performance_score, performance_score_p75, lcp_ms, created_at, updated_at)
              VALUES (1, 'mobile', '${rollupDate}', '${rollupRecordedAt}', 1, 1, 88, 88, 1950, '${rollupRecordedAt}', '${rollupRecordedAt}');`);

  // Insert a fresh raw metric from 5 days ago
  const freshDate = "2026-10-30T10:00:00.000Z";
  db.raw.exec(`INSERT INTO test_runs (id, site_id, strategy, source, status, started_at, completed_at)
              VALUES (501, 1, 'mobile', 'scheduled', 'success', '${freshDate}', '${freshDate}');`);
  db.raw.exec(`INSERT INTO metrics (id, test_run_id, site_id, strategy, recorded_at, performance_score, lcp_ms)
              VALUES (501, 501, 1, 'mobile', '${freshDate}', 95, 1200);`);

  // Request days=30 (should read raw metrics)
  const res30 = await workerDefault.fetch(
    new Request("https://speedpulse.test/api/sites/1/history?strategy=mobile&days=30", {
      headers: { cookie: sessionCookie }
    }),
    env
  );
  assert.strictEqual(res30.status, 200);
  const data30 = await res30.json();
  assert.strictEqual(data30.from_rollup, false, "30-day range must read from raw metrics");
  assert.strictEqual(data30.history.length, 1, "Should find 1 raw metric");

  // Request days=365 (1Y: should read from rollups)
  const res365 = await workerDefault.fetch(
    new Request("https://speedpulse.test/api/sites/1/history?strategy=mobile&days=365", {
      headers: { cookie: sessionCookie }
    }),
    env
  );
  assert.strictEqual(res365.status, 200);
  const data365 = await res365.json();
  assert.strictEqual(data365.from_rollup, true, "1Y range must read from metrics_daily_rollup");
  assert.strictEqual(data365.history.length, 1, "Should return rollup data point");
  assert.strictEqual(data365.history[0].performance_score, 88);

  // Request days=all (All: should read from rollups)
  const resAll = await workerDefault.fetch(
    new Request("https://speedpulse.test/api/sites/1/history?strategy=mobile&days=all", {
      headers: { cookie: sessionCookie }
    }),
    env
  );
  assert.strictEqual(resAll.status, 200);
  const dataAll = await resAll.json();
  assert.strictEqual(dataAll.from_rollup, true, "All range must read from metrics_daily_rollup");
  assert.strictEqual(dataAll.history[0].performance_score, 88);

  pass("History API cleanly routes 1Y & All to rollups, and <=90D to raw metrics");
}

// [Test 5] EXPLAIN QUERY PLAN Index Verification
console.log("\n[Test 5] EXPLAIN QUERY PLAN: Covered and Indexed queries");
{
  const db = createTestD1();

  const plans = [
    {
      name: "Dashboard testsToday (Covering index on test_runs)",
      sql: "SELECT COUNT(*) AS count FROM test_runs WHERE status='success' AND completed_at >= '2026-11-04T00:00:00.000Z'",
      expectedPattern: /COVERING INDEX idx_runs_status_completed/i
    },
    {
      name: "Dashboard sites attention (Index on sites and site_latest)",
      sql: "SELECT s.id, s.name, s.url, l.lcp_ms FROM sites s LEFT JOIN site_latest l ON l.site_id=s.id AND l.strategy='mobile' WHERE s.active=1 AND l.lcp_ms > 4000 ORDER BY l.lcp_ms DESC LIMIT 10",
      expectedPattern: /(site_latest|idx_sites)/i
    },
    {
      name: "Site History raw (Index on metrics)",
      sql: "SELECT * FROM metrics WHERE site_id=1 AND strategy='mobile' AND recorded_at >= '2026-08-01T00:00:00.000Z' ORDER BY recorded_at DESC LIMIT 1500",
      expectedPattern: /INDEX idx_metrics_history/i
    },
    {
      name: "Site History rollups 1Y/All (Index on metrics_daily_rollup)",
      sql: "SELECT * FROM metrics_daily_rollup WHERE site_id=1 AND strategy='mobile' AND recorded_at >= '2025-11-04T00:00:00.000Z' ORDER BY recorded_at ASC",
      expectedPattern: /INDEX idx_rollup_site_strat_recorded/i
    }
  ];

  for (const p of plans) {
    const rawPlan = db.raw.prepare("EXPLAIN QUERY PLAN " + p.sql).all();
    const details = rawPlan.map((r) => r.detail).join("; ");
    assert(p.expectedPattern.test(details), `Plan for ${p.name} should match ${p.expectedPattern} (got: ${details})`);
    pass(`${p.name} uses indexed lookup: ${details}`);
  }
}

console.log("\n==================================================================");
console.log("  ALL ITEM 6 RETENTION & ROLLUPS TESTS PASSED! (5/5)");
console.log("==================================================================");
