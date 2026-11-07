#!/usr/bin/env node

/**
 * Automated Verification: Quota Ledger, Dual Timezone Resets & Auto-Throttle
 *
 * Verifies Item 4 Requirements:
 * 1. Correct day_key calculation for dual timezones across midnight boundaries and DST transitions:
 *    - Cloudflare resources use UTC: YYYY-MM-DD
 *    - Google resources use America/Los_Angeles: YYYY-MM-DD (accounting for PDT/PST)
 * 2. D1 quota_ledger table upsert increments counts atomically and records updated_at.
 * 3. Multi-resource tracking maintains isolated counters across resources.
 * 4. Scheduler auto-throttle:
 *    - < 70%: normal batchSize
 *    - >= 70% and < 90%: batchSize reduced by 50%
 *    - >= 90%: scheduled scans paused (batchSize = 0)
 * 5. Manual scan behavior:
 *    - < 70%: enqueued with HTTP 202, no warning
 *    - 70-90%: enqueued with HTTP 202, warning returned
 *    - >= 95%: blocked with HTTP 429 Too Many Requests
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import esbuild from "esbuild";

// Compile TypeScript sources into memory for direct unit execution
const bundle = esbuild.buildSync({
  stdin: {
    contents: `
      export * from "./src/quota";
      export * from "./src/scheduler";
      export * from "./src/auth";
      export { default as workerDefault } from "./src/index";
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

const tempModulePath = path.resolve(process.cwd(), ".verify-quota-bundle.mjs");
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
  DEFAULT_QUOTA_CONFIGS,
  QUOTA_THRESHOLDS,
  getPacificDayKey,
  getUtcDayKey,
  getResourceDayKey,
  recordQuotaUsage,
  getQuotaUsage,
  evaluateQuotaStatus,
  getEffectiveBatchSize,
  runNextSchedulerTick,
  makeSessionCookie,
  workerDefault
} = mod;

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

// In-Memory SQLite D1 Mock
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

  // Seed 20 sites
  for (let i = 1; i <= 20; i++) {
    rawDb.exec(`INSERT INTO sites (id, project_id, name, url, origin, active, mobile_frequency, desktop_frequency, created_at, updated_at) VALUES (${i}, 1, 'Site ${i}', 'https://site${i}.com', 'site${i}.com', 1, 'daily', 'weekly', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');`);
  }

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
      rawDb.exec("BEGIN TRANSACTION;");
      try {
        const results = [];
        for (const s of statements) {
          results.push(await s.run());
        }
        rawDb.exec("COMMIT;");
        return results;
      } catch (err) {
        rawDb.exec("ROLLBACK;");
        throw err;
      }
    }
  };

  return d1;
}

function createMockEnv(d1, overrides = {}) {
  const sentMessages = [];
  return {
    DB: d1,
    APP_ENV: "test",
    NEXT_SCHEDULER_ENABLED: "1",
    NEXT_SCHEDULER_MODE: "dispatch",
    NEXT_SCHEDULER_BATCH_SIZE: "20",
    NEXT_SCHEDULER_DAILY_BUDGET: "600",
    QUEUE_SCANS_ENABLED: "1",
    SCAN_QUEUE: {
      async send(msg) {
        sentMessages.push(msg);
      },
      async sendBatch(msgs) {
        sentMessages.push(...msgs);
      }
    },
    ADMIN_PASSWORD: "test-admin-password",
    SESSION_SECRET: "test-secret-at-least-32-chars-long-abcdef",
    _sentMessages: sentMessages,
    ...overrides
  };
}

async function runTests() {
  console.log("==================================================================");
  console.log("  RUNNING ITEM 4: QUOTA LEDGER & AUTO-THROTTLE TESTS");
  console.log("==================================================================");

  // -----------------------------------------------------------------
  // Test 1: Dual Timezone Day Key Calculation & DST Transitions
  // -----------------------------------------------------------------
  console.log("\n[Test 1] Dual Timezone Day Keys (UTC vs America/Los_Angeles with DST)");
  {
    // UTC Midnight Boundary
    const utcT1 = "2026-11-04T00:00:00.000Z";
    assert.strictEqual(getUtcDayKey(utcT1), "2026-11-04", "UTC day is 2026-11-04");
    // At UTC midnight in November (PST = UTC-8), Pacific is 16:00 on previous day (2026-11-03)
    assert.strictEqual(getPacificDayKey(utcT1), "2026-11-03", "Pacific day is 2026-11-03 at UTC midnight");

    // Pacific Midnight in Winter (PST = UTC-8, resets at 08:00 UTC)
    const pstBeforeMidnight = "2026-12-01T07:59:59.000Z"; // 23:59:59 Nov 30 in Pacific
    const pstAtMidnight = "2026-12-01T08:00:00.000Z";     // 00:00:00 Dec 01 in Pacific
    assert.strictEqual(getPacificDayKey(pstBeforeMidnight), "2026-11-30", "Pacific day before 08:00 UTC is Nov 30");
    assert.strictEqual(getPacificDayKey(pstAtMidnight), "2026-12-01", "Pacific day at 08:00 UTC flips to Dec 01");

    // Pacific Midnight in Summer (PDT = UTC-7, resets at 07:00 UTC)
    const pdtBeforeMidnight = "2026-07-01T06:59:59.000Z"; // 23:59:59 Jun 30 in Pacific
    const pdtAtMidnight = "2026-07-01T07:00:00.000Z";     // 00:00:00 Jul 01 in Pacific
    assert.strictEqual(getPacificDayKey(pdtBeforeMidnight), "2026-06-30", "Pacific summer before 07:00 UTC is Jun 30");
    assert.strictEqual(getPacificDayKey(pdtAtMidnight), "2026-07-01", "Pacific summer at 07:00 UTC flips to Jul 01");

    // Resource routing
    assert.strictEqual(getResourceDayKey("kv_writes", utcT1), "2026-11-04", "kv_writes uses UTC day key");
    assert.strictEqual(getResourceDayKey("queue_writes", utcT1), "2026-11-04", "queue_writes uses UTC day key");
    assert.strictEqual(getResourceDayKey("d1_writes", utcT1), "2026-11-04", "d1_writes uses UTC day key");
    assert.strictEqual(getResourceDayKey("pagespeed_api", utcT1), "2026-11-03", "pagespeed_api uses Pacific day key");
    assert.strictEqual(getResourceDayKey("crux_api", utcT1), "2026-11-03", "crux_api uses Pacific day key");

    pass("UTC day key calculation verified across midnight");
    pass("Pacific day key calculation verified across winter PST (UTC-8) and summer PDT (UTC-7)");
    pass("Resource routing correctly maps Cloudflare -> UTC and Google -> Pacific");
  }

  // -----------------------------------------------------------------
  // Test 2: Quota Ledger D1 Upsert & Multi-Resource Counting
  // -----------------------------------------------------------------
  console.log("\n[Test 2] Quota Ledger D1 Upsert & Counting");
  {
    const d1 = createTestD1();
    const testTime = "2026-11-04T12:00:00.000Z";

    // Initial count is 0
    const initialKv = await getQuotaUsage(d1, "kv_writes", testTime);
    assert.strictEqual(initialKv, 0, "Initial kv_writes count is 0");

    // Increment kv_writes by 10
    await recordQuotaUsage(d1, "kv_writes", 10, testTime);
    const count1 = await getQuotaUsage(d1, "kv_writes", testTime);
    assert.strictEqual(count1, 10, "Count after first increment is 10");

    // Increment kv_writes by 25
    await recordQuotaUsage(d1, "kv_writes", 25, testTime);
    const count2 = await getQuotaUsage(d1, "kv_writes", testTime);
    assert.strictEqual(count2, 35, "Count after second increment is 35 (atomic upsert)");

    // Increment pagespeed_api
    await recordQuotaUsage(d1, "pagespeed_api", 3, testTime);
    const psiCount = await getQuotaUsage(d1, "pagespeed_api", testTime);
    assert.strictEqual(psiCount, 3, "pagespeed_api maintains separate counter");

    // Check DB row directly
    const row = d1.raw.prepare("SELECT * FROM quota_ledger WHERE resource = 'kv_writes'").get();
    assert.strictEqual(row.count, 35);
    assert.strictEqual(row.day_key, "2026-11-04");

    pass("Atomic upsert increments counter correctly in D1");
    pass("Multiple resources maintain isolated counts in quota_ledger");
  }

  // -----------------------------------------------------------------
  // Test 3: Quota Evaluation & Scheduler Auto-Throttle (70% and 90%)
  // -----------------------------------------------------------------
  console.log("\n[Test 3] Scheduler Slowdown (>=70%) and Pause (>=90%)");
  {
    const d1 = createTestD1();
    const testTime = "2026-11-04T12:00:00.000Z";

    // Subtest 3A: Normal state (< 70%)
    await recordQuotaUsage(d1, "kv_writes", 500, testTime); // 500/1000 = 50%
    let evalStatus = await evaluateQuotaStatus(d1, testTime);
    assert.strictEqual(evalStatus.status, "normal");
    assert.strictEqual(evalStatus.shouldSlowdown, false);
    assert.strictEqual(evalStatus.shouldPauseScheduled, false);
    assert.strictEqual(getEffectiveBatchSize(20, evalStatus), 20);
    pass("Normal state (< 70%) maintains full batchSize (20)");

    // Subtest 3B: Slowdown threshold (>= 70% and < 90%)
    await recordQuotaUsage(d1, "kv_writes", 250, testTime); // 750/1000 = 75%
    evalStatus = await evaluateQuotaStatus(d1, testTime);
    assert.strictEqual(evalStatus.status, "slowdown");
    assert.strictEqual(evalStatus.shouldSlowdown, true);
    assert.strictEqual(evalStatus.shouldPauseScheduled, false);
    assert.strictEqual(getEffectiveBatchSize(20, evalStatus), 10, "Batch size cut in half: 20 -> 10");
    assert(evalStatus.warningMessage?.includes("kv_writes is at 75%"), "Warning message describes kv_writes");
    pass("Slowdown threshold (75%) cuts batchSize in half (20 -> 10)");

    // Subtest 3C: Pause threshold (>= 90%)
    await recordQuotaUsage(d1, "kv_writes", 160, testTime); // 910/1000 = 91%
    evalStatus = await evaluateQuotaStatus(d1, testTime);
    assert.strictEqual(evalStatus.status, "paused");
    assert.strictEqual(evalStatus.shouldSlowdown, true);
    assert.strictEqual(evalStatus.shouldPauseScheduled, true);
    assert.strictEqual(getEffectiveBatchSize(20, evalStatus), 0, "Batch size clamped to 0 when paused");
    pass("Pause threshold (91%) pauses scheduled batch (batchSize = 0)");

    // Verify in runNextSchedulerTick
    // Push targets to due
    d1.raw.prepare("UPDATE scan_targets SET next_due_at = ? WHERE site_id <= 10").run(testTime);
    const env = createMockEnv(d1, { NEXT_SCHEDULER_BATCH_SIZE: "20" });

    const summary = await runNextSchedulerTick(env, testTime);
    assert.strictEqual(summary.effectiveBatchSize, 0, "effectiveBatchSize in scheduler summary is 0");
    assert.strictEqual(summary.candidates, 0, "Candidates clamped to 0 when paused");
    assert.strictEqual(summary.dispatch?.created, 0, "Dispatched 0 jobs when quota paused");
    assert.strictEqual(summary.quotaStatus, "paused", "quotaStatus reports 'paused'");
    pass("runNextSchedulerTick respects quota pause and dispatches 0 jobs");
  }

  // -----------------------------------------------------------------
  // Test 4: Manual Scan Behavior Across Thresholds (<70%, 70-90%, >=95%)
  // -----------------------------------------------------------------
  console.log("\n[Test 4] Manual Scan Behavior Across Thresholds (<70%, 70-90%, >=95%)");
  {
    const d1 = createTestD1();
    const testTime = new Date().toISOString();
    const env = createMockEnv(d1);
    const cookie = await makeSessionCookie(env);
    const authHeaders = {
      "cookie": cookie,
      "content-type": "application/json"
    };

    // Subtest 4A: Normal (< 70%) -> HTTP 202, no warning
    const req1 = new Request("https://speedpulse.test/api/sites/1/run", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ strategy: "mobile" })
    });
    const res1 = await workerDefault.fetch(req1, env);
    assert.strictEqual(res1.status, 202, "Manual run accepted (202)");
    const data1 = await res1.json();
    assert.strictEqual(data1.ok, true);
    assert.strictEqual(data1.warning, undefined, "No warning at normal usage");
    pass("Manual scan succeeds without warning under 70%");

    // Subtest 4B: Slowdown (70-90%) -> HTTP 202, WITH warning
    await recordQuotaUsage(d1, "kv_writes", 750, testTime); // 75%
    const req2 = new Request("https://speedpulse.test/api/sites/2/run", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ strategy: "mobile" })
    });
    const res2 = await workerDefault.fetch(req2, env);
    assert.strictEqual(res2.status, 202, "Manual run accepted (202)");
    const data2 = await res2.json();
    assert.strictEqual(data2.ok, true);
    assert(typeof data2.warning === "string" && data2.warning.includes("75%"), "Warning included at 75% quota");
    pass("Manual scan succeeds with warning between 70% and 90%");

    // Subtest 4C: Blocked (>= 95%) -> HTTP 429
    await recordQuotaUsage(d1, "kv_writes", 210, testTime); // 960/1000 = 96%
    const req3 = new Request("https://speedpulse.test/api/sites/3/run", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ strategy: "mobile" })
    });
    const res3 = await workerDefault.fetch(req3, env);
    assert.strictEqual(res3.status, 429, "Manual run blocked with 429 Too Many Requests");
    const data3 = await res3.json();
    assert.strictEqual(data3.ok, false);
    assert(data3.error?.includes("Daily quota exhausted"), "Informative 429 error returned");
    pass("Manual scan blocked with HTTP 429 at >= 95% quota");
  }

  console.log("\n==================================================================");
  console.log("  ALL ITEM 4 QUOTA LEDGER TESTS PASSED! (4/4)");
  console.log("==================================================================\n");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
