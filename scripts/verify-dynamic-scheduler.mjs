#!/usr/bin/env node

/**
 * Automated Verification: Dynamic Scheduler Dispatch & Budget Safety
 *
 * Verifies Item 2 Requirements:
 * 1. Dispatch per tick is dynamic: min(remaining daily budget, batch limit).
 * 2. High headroom: dispatches batchSize when budgetRemaining >= batchSize.
 * 3. Low headroom: clamps dispatch to budgetRemaining when budgetRemaining < batchSize.
 * 4. Zero headroom: dispatches 0 targets when budget is exhausted (budgetRemaining === 0).
 * 5. Budget resets at 00:00 UTC (advancing date resets scheduledToday counter).
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
      export * from "./src/scheduler";
    `,
    resolveDir: process.cwd(),
    sourcefile: "virtual-scheduler-entry.ts",
    loader: "ts"
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false
});

const tempModulePath = path.resolve(process.cwd(), ".verify-scheduler-bundle.mjs");
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
  runNextSchedulerTick,
  previewNextScheduler,
  countScheduledJobsSince
} = mod;

// -----------------------------------------------------------------------------
// Test Database & Environment Setup
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

  // Seed 50 sites
  for (let i = 1; i <= 50; i++) {
    rawDb.exec(`INSERT INTO sites (id, project_id, name, url, origin, active, mobile_frequency, desktop_frequency, created_at, updated_at) VALUES (${i}, 1, 'Site ${i}', 'https://site${i}.com', 'site${i}.com', 1, 'daily', 'weekly', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');`);
  }

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

function createMockEnv(d1, overrides = {}) {
  const sentMessages = [];
  return {
    DB: d1,
    APP_ENV: "test",
    NEXT_SCHEDULER_MODE: "dispatch",
    NEXT_SCHEDULER_BATCH_SIZE: "25",
    NEXT_SCHEDULER_DAILY_BUDGET: "600",
    QUEUE_SCANS_ENABLED: "1",
    SCAN_QUEUE: {
      send(msg) {
        sentMessages.push(msg);
        return Promise.resolve();
      }
    },
    _sentMessages: sentMessages,
    ...overrides
  };
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
  console.log("  RUNNING ITEM 2: DYNAMIC SCHEDULER DISPATCH TESTS");
  console.log("==================================================================");

  const nowIso = "2026-11-04T12:00:00.000Z";

  // Test 1: Full Headroom Dispatch (dispatches min(batchSize, remainingBudget))
  console.log("\n[Test 1] Full Headroom: remainingBudget (600) >= batchSize (25)");
  {
    const d1 = createTestD1();
    // Mark 30 targets due in the past
    d1.raw.prepare("UPDATE scan_targets SET next_due_at = ? WHERE site_id <= 30 AND strategy = 'mobile'").run("2026-11-04T11:00:00.000Z");

    const env = createMockEnv(d1, {
      NEXT_SCHEDULER_BATCH_SIZE: "25",
      NEXT_SCHEDULER_DAILY_BUDGET: "600"
    });

    const summary = await runNextSchedulerTick(env, nowIso);
    assert(summary.ok === true, "Scheduler tick completed successfully");
    assert(summary.candidates === 25, `Clamped candidates to batchSize: ${summary.candidates}`);
    assert(summary.dispatch?.created === 25, `Dispatched exactly batchSize (25) jobs`);
    assert(summary.budgetRemaining === 600, `Initial budget remaining was 600`);
    assert(env._sentMessages.length === 25, `Queue received exactly 25 messages`);
  }

  // Test 2: Low Headroom Clamping (remainingBudget < batchSize)
  console.log("\n[Test 2] Low Headroom: remainingBudget (7) < batchSize (25)");
  {
    const d1 = createTestD1();
    // Simulate 593 jobs already scheduled today (leaving budgetRemaining = 7)
    const todayIso = "2026-11-04T08:00:00.000Z";
    for (let i = 1; i <= 593; i++) {
      d1.raw.prepare(`
        INSERT INTO scan_jobs (site_id, strategy, trigger, status, created_at, updated_at)
        VALUES (1, 'mobile', 'scheduled', 'success', ?, ?)
      `).run(todayIso, todayIso);
    }

    // Mark 20 targets due
    d1.raw.prepare("UPDATE scan_targets SET next_due_at = ? WHERE site_id <= 20 AND strategy = 'mobile'").run("2026-11-04T11:00:00.000Z");

    const env = createMockEnv(d1, {
      NEXT_SCHEDULER_BATCH_SIZE: "25",
      NEXT_SCHEDULER_DAILY_BUDGET: "600"
    });

    const summary = await runNextSchedulerTick(env, nowIso);
    assert(summary.scheduledToday === 593, `Correctly detected 593 scheduled jobs today`);
    assert(summary.budgetRemaining === 7, `Correctly calculated remaining budget: 7`);
    assert(summary.candidates === 7, `Clamped candidate limit to min(25, 7) = 7`);
    assert(summary.dispatch?.created === 7, `Dispatched exactly 7 jobs (preventing quota overrun)`);
    assert(env._sentMessages.length === 7, `Queue received exactly 7 messages`);
  }

  // Test 3: Exhausted Budget (remainingBudget === 0)
  console.log("\n[Test 3] Budget Exhaustion: remainingBudget (0)");
  {
    const d1 = createTestD1();
    // Simulate 600 jobs scheduled today
    const todayIso = "2026-11-04T08:00:00.000Z";
    for (let i = 1; i <= 600; i++) {
      d1.raw.prepare(`
        INSERT INTO scan_jobs (site_id, strategy, trigger, status, created_at, updated_at)
        VALUES (1, 'mobile', 'scheduled', 'success', ?, ?)
      `).run(todayIso, todayIso);
    }

    // Mark 10 targets due
    d1.raw.prepare("UPDATE scan_targets SET next_due_at = ? WHERE site_id <= 10 AND strategy = 'mobile'").run("2026-11-04T11:00:00.000Z");

    const env = createMockEnv(d1, {
      NEXT_SCHEDULER_BATCH_SIZE: "25",
      NEXT_SCHEDULER_DAILY_BUDGET: "600"
    });

    const summary = await runNextSchedulerTick(env, nowIso);
    assert(summary.scheduledToday === 600, `Detected 600 scheduled jobs today`);
    assert(summary.budgetRemaining === 0, `budgetRemaining is 0`);
    assert(summary.candidates === 0, `Candidate limit is 0`);
    assert(summary.dispatch?.created === 0, `Dispatched 0 jobs (safely paused)`);
    assert(env._sentMessages.length === 0, `No messages sent to Queue`);
  }

  // Test 4: Midnight 00:00 UTC Reset Resumes Dispatch
  console.log("\n[Test 4] Midnight 00:00 UTC Day Rollover Resets Budget");
  {
    const d1 = createTestD1();
    // 600 jobs created on 2026-11-03
    const day1Iso = "2026-11-03T22:00:00.000Z";
    for (let i = 1; i <= 600; i++) {
      d1.raw.prepare(`
        INSERT INTO scan_jobs (site_id, strategy, trigger, status, created_at, updated_at)
        VALUES (1, 'mobile', 'scheduled', 'success', ?, ?)
      `).run(day1Iso, day1Iso);
    }

    const day2Iso = "2026-11-04T00:05:00.000Z";
    // Push all targets into future
    d1.raw.prepare("UPDATE scan_targets SET next_due_at = '2026-11-05T00:00:00.000Z'").run();
    // Mark exactly 10 targets due on Day 2
    d1.raw.prepare("UPDATE scan_targets SET next_due_at = ? WHERE site_id <= 10 AND strategy = 'mobile'").run(day2Iso);

    const env = createMockEnv(d1, {
      NEXT_SCHEDULER_BATCH_SIZE: "25",
      NEXT_SCHEDULER_DAILY_BUDGET: "600"
    });

    // Run tick on Day 2 (00:05 UTC)
    const summary = await runNextSchedulerTick(env, day2Iso);
    assert(summary.scheduledToday === 0, `Day 2 scheduledToday reset to 0 at 00:00 UTC`);
    assert(summary.budgetRemaining === 600, `Day 2 budgetRemaining fully restored to 600`);
    assert(summary.dispatch?.created === 10, `Dispatched all 10 due targets on Day 2`);
  }

  console.log("\n==================================================================");
  console.log("  ALL DYNAMIC SCHEDULER TESTS PASSED! (4/4)");
  console.log("==================================================================\n");
}

runTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
