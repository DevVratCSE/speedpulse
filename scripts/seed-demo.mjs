#!/usr/bin/env node

/**
 * SpeedPulse Demo Seeder Script
 *
 * Populates a fresh or existing SpeedPulse instance with 6 public benchmark websites:
 * 1. Wikipedia (https://en.wikipedia.org/wiki/Main_Page)
 * 2. GitHub (https://github.com)
 * 3. Cloudflare (https://www.cloudflare.com)
 * 4. WordPress.org (https://wordpress.org)
 * 5. Hacker News (https://news.ycombinator.com)
 * 6. MDN Web Docs (https://developer.mozilla.org)
 *
 * What it populates:
 * - Project: "Web Benchmarks"
 * - 6 public websites with daily mobile and weekly desktop schedules
 * - Active scan_targets for each site and strategy
 * - Latest performance metrics (site_latest)
 * - Historical test runs and metrics over the past 7 days
 * - Daily rollups (metrics_daily_rollup) for instant long-range graphs
 * - Fresh cron heartbeat in system_state
 *
 * Usage:
 *   node scripts/seed-demo.mjs --sql                     # Print SQL commands to stdout
 *   node scripts/seed-demo.mjs --sql --out=seed.sql     # Save SQL script to file
 *   node scripts/seed-demo.mjs --local                  # Execute against local wrangler D1 database
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

export const DEMO_SITES = [
  {
    name: "Wikipedia",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    origin: "https://en.wikipedia.org",
    mobile: {
      score: 92,
      fcp: 1250,
      lcp: 1850,
      tbt: 80,
      cls: 0.012,
      speedIndex: 1600,
      fieldLcp: 1700,
      fieldInp: 65,
      fieldCls: 0.01
    },
    desktop: {
      score: 98,
      fcp: 620,
      lcp: 880,
      tbt: 20,
      cls: 0.005,
      speedIndex: 750,
      fieldLcp: 800,
      fieldInp: 35,
      fieldCls: 0.005
    }
  },
  {
    name: "GitHub",
    url: "https://github.com",
    origin: "https://github.com",
    mobile: {
      score: 83,
      fcp: 1780,
      lcp: 2650,
      tbt: 240,
      cls: 0.035,
      speedIndex: 2300,
      fieldLcp: 2400,
      fieldInp: 110,
      fieldCls: 0.03
    },
    desktop: {
      score: 95,
      fcp: 820,
      lcp: 1220,
      tbt: 55,
      cls: 0.010,
      speedIndex: 1100,
      fieldLcp: 1150,
      fieldInp: 45,
      fieldCls: 0.01
    }
  },
  {
    name: "Cloudflare",
    url: "https://www.cloudflare.com",
    origin: "https://www.cloudflare.com",
    mobile: {
      score: 89,
      fcp: 1420,
      lcp: 2180,
      tbt: 140,
      cls: 0.018,
      speedIndex: 1950,
      fieldLcp: 2050,
      fieldInp: 75,
      fieldCls: 0.015
    },
    desktop: {
      score: 97,
      fcp: 680,
      lcp: 940,
      tbt: 30,
      cls: 0.006,
      speedIndex: 850,
      fieldLcp: 900,
      fieldInp: 40,
      fieldCls: 0.005
    }
  },
  {
    name: "WordPress.org",
    url: "https://wordpress.org",
    origin: "https://wordpress.org",
    mobile: {
      score: 79,
      fcp: 2100,
      lcp: 3150,
      tbt: 310,
      cls: 0.045,
      speedIndex: 2800,
      fieldLcp: 2900,
      fieldInp: 135,
      fieldCls: 0.04
    },
    desktop: {
      score: 92,
      fcp: 910,
      lcp: 1420,
      tbt: 65,
      cls: 0.018,
      speedIndex: 1250,
      fieldLcp: 1350,
      fieldInp: 55,
      fieldCls: 0.015
    }
  },
  {
    name: "Hacker News",
    url: "https://news.ycombinator.com",
    origin: "https://news.ycombinator.com",
    mobile: {
      score: 99,
      fcp: 510,
      lcp: 740,
      tbt: 0,
      cls: 0.001,
      speedIndex: 650,
      fieldLcp: 700,
      fieldInp: 25,
      fieldCls: 0.001
    },
    desktop: {
      score: 100,
      fcp: 340,
      lcp: 460,
      tbt: 0,
      cls: 0.000,
      speedIndex: 420,
      fieldLcp: 450,
      fieldInp: 15,
      fieldCls: 0.000
    }
  },
  {
    name: "MDN Web Docs",
    url: "https://developer.mozilla.org",
    origin: "https://developer.mozilla.org",
    mobile: {
      score: 86,
      fcp: 1550,
      lcp: 2350,
      tbt: 175,
      cls: 0.025,
      speedIndex: 2050,
      fieldLcp: 2200,
      fieldInp: 85,
      fieldCls: 0.02
    },
    desktop: {
      score: 96,
      fcp: 720,
      lcp: 1060,
      tbt: 35,
      cls: 0.008,
      speedIndex: 920,
      fieldLcp: 1000,
      fieldInp: 40,
      fieldCls: 0.008
    }
  }
];

/**
 * Generates idempotent SQL statements to seed public benchmark sites and history.
 */
export function generateDemoSeedSql(baseTime = new Date()) {
  const nowIso = baseTime.toISOString();
  const statements = [];

  statements.push("-- ================================================================");
  statements.push("-- SpeedPulse Open Source Demo Seed Data");
  statements.push(`-- Generated at: ${nowIso}`);
  statements.push("-- ================================================================\n");
  statements.push("PRAGMA foreign_keys = ON;\n");

  // 1. Project
  statements.push("-- 1. Benchmark Project");
  statements.push(`INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at)
VALUES (1, 'Web Benchmarks', 'Public web benchmarks and performance monitoring demonstration', '${nowIso}', '${nowIso}');\n`);

  // 2. Sites & Targets
  statements.push("-- 2. Monitored Sites");
  DEMO_SITES.forEach((site, index) => {
    const siteId = index + 1;
    const mobileDue = new Date(baseTime.getTime() + (index * 15 * 60 * 1000)).toISOString();
    const desktopDue = new Date(baseTime.getTime() + (24 * 60 * 60 * 1000) + (index * 15 * 60 * 1000)).toISOString();

    statements.push(`INSERT OR IGNORE INTO sites (
  id, project_id, name, url, origin, active,
  mobile_frequency, desktop_frequency,
  mobile_next_check_at, desktop_next_check_at,
  mobile_last_status, desktop_last_status,
  mobile_last_run_at, desktop_last_run_at,
  created_at, updated_at
) VALUES (
  ${siteId}, 1, '${site.name}', '${site.url}', '${site.origin}', 1,
  'daily', 'weekly',
  '${mobileDue}', '${desktopDue}',
  'success', 'success',
  '${nowIso}', '${nowIso}',
  '${nowIso}', '${nowIso}'
);`);

    // Ensure scan_targets are active and properly scheduled
    statements.push(`INSERT INTO scan_targets (site_id, strategy, enabled, interval_hours, next_due_at, last_success_at, priority, created_at, updated_at)
VALUES (${siteId}, 'mobile', 1, 24, '${mobileDue}', '${nowIso}', 100, '${nowIso}', '${nowIso}')
ON CONFLICT(site_id, strategy) DO UPDATE SET
  enabled = 1,
  interval_hours = 24,
  next_due_at = '${mobileDue}',
  last_success_at = '${nowIso}',
  updated_at = '${nowIso}';`);

    statements.push(`INSERT INTO scan_targets (site_id, strategy, enabled, interval_hours, next_due_at, last_success_at, priority, created_at, updated_at)
VALUES (${siteId}, 'desktop', 1, 168, '${desktopDue}', '${nowIso}', 100, '${nowIso}', '${nowIso}')
ON CONFLICT(site_id, strategy) DO UPDATE SET
  enabled = 1,
  interval_hours = 168,
  next_due_at = '${desktopDue}',
  last_success_at = '${nowIso}',
  updated_at = '${nowIso}';\n`);
  });

  // 3. Test Runs, Metrics, and Latest State across past 5 days
  statements.push("-- 3. Test Runs & Metrics History");
  let runIdCounter = 1000;

  DEMO_SITES.forEach((site, index) => {
    const siteId = index + 1;
    const strategies = ["mobile", "desktop"];

    for (const strat of strategies) {
      const cfg = site[strat];
      let latestRunId = null;
      let latestRecordedAt = null;

      // Generate 5 days of history (from 4 days ago up to today)
      for (let dayOffset = 4; dayOffset >= 0; dayOffset--) {
        runIdCounter++;
        const runTime = new Date(baseTime.getTime() - (dayOffset * 86400 * 1000) - ((index + 1) * 3600 * 1000));
        const runIso = runTime.toISOString();
        const dayKey = runIso.slice(0, 10);

        // Small realistic jitter per day
        const jitterMultiplier = 1 + (((dayOffset * 13) % 7) - 3) * 0.015;
        const score = Math.min(100, Math.max(50, Math.round(cfg.score * (1 + (((dayOffset * 7) % 5) - 2) * 0.01))));
        const fcp = Math.round(cfg.fcp * jitterMultiplier);
        const lcp = Math.round(cfg.lcp * jitterMultiplier);
        const tbt = Math.round(cfg.tbt * jitterMultiplier);
        const cls = Math.round(cfg.cls * jitterMultiplier * 1000) / 1000;
        const speedIndex = Math.round(cfg.speedIndex * jitterMultiplier);

        statements.push(`INSERT OR IGNORE INTO test_runs (id, site_id, strategy, source, status, started_at, completed_at, psi_fetch_time, lighthouse_version)
VALUES (${runIdCounter}, ${siteId}, '${strat}', 'scheduled', 'success', '${runIso}', '${runIso}', '${runIso}', '12.0.0');`);

        statements.push(`INSERT OR IGNORE INTO metrics (
  test_run_id, site_id, strategy, recorded_at,
  performance_score, accessibility_score, seo_score, best_practices_score,
  fcp_ms, lcp_ms, tbt_ms, cls, speed_index_ms,
  field_lcp_ms, field_inp_ms, field_cls, field_data_source
) VALUES (
  ${runIdCounter}, ${siteId}, '${strat}', '${runIso}',
  ${score}, 95, 96, 96,
  ${fcp}, ${lcp}, ${tbt}, ${cls}, ${speedIndex},
  ${cfg.fieldLcp}, ${cfg.fieldInp}, ${cfg.fieldCls}, 'crux'
);`);

        // Rollups for historical graphs
        statements.push(`INSERT INTO metrics_daily_rollup (
  site_id, strategy, rollup_date, recorded_at, total_runs, successful_runs,
  performance_score, accessibility_score, seo_score, best_practices_score,
  performance_score_p75, accessibility_score_p75, seo_score_p75, best_practices_score_p75,
  fcp_ms, lcp_ms, tbt_ms, cls, speed_index_ms,
  fcp_ms_p75, lcp_ms_p75, tbt_ms_p75, cls_p75, speed_index_ms_p75,
  field_lcp_ms, field_inp_ms, field_cls, field_data_source,
  created_at, updated_at
) VALUES (
  ${siteId}, '${strat}', '${dayKey}', '${runIso}', 1, 1,
  ${score}, 95, 96, 96,
  ${score}, 95, 96, 96,
  ${fcp}, ${lcp}, ${tbt}, ${cls}, ${speedIndex},
  ${Math.round(fcp * 1.05)}, ${Math.round(lcp * 1.05)}, ${Math.round(tbt * 1.05)}, ${cls}, ${speedIndex},
  ${cfg.fieldLcp}, ${cfg.fieldInp}, ${cfg.fieldCls}, 'crux',
  '${runIso}', '${runIso}'
) ON CONFLICT(site_id, strategy, rollup_date) DO UPDATE SET
  total_runs = excluded.total_runs,
  successful_runs = excluded.successful_runs,
  performance_score = excluded.performance_score,
  lcp_ms = excluded.lcp_ms,
  recorded_at = excluded.recorded_at,
  updated_at = excluded.updated_at;`);

        if (dayOffset === 0) {
          latestRunId = runIdCounter;
          latestRecordedAt = runIso;
        }
      }

      // 4. Update site_latest with the newest run
      if (latestRunId) {
        statements.push(`INSERT INTO site_latest (
  site_id, strategy, test_run_id, recorded_at,
  performance_score, accessibility_score, seo_score, best_practices_score,
  fcp_ms, lcp_ms, tbt_ms, cls, speed_index_ms,
  field_lcp_ms, field_inp_ms, field_cls, field_data_source
) VALUES (
  ${siteId}, '${strat}', ${latestRunId}, '${latestRecordedAt}',
  ${cfg.score}, 95, 96, 96,
  ${cfg.fcp}, ${cfg.lcp}, ${cfg.tbt}, ${cfg.cls}, ${cfg.speedIndex},
  ${cfg.fieldLcp}, ${cfg.fieldInp}, ${cfg.fieldCls}, 'crux'
) ON CONFLICT(site_id, strategy) DO UPDATE SET
  test_run_id = excluded.test_run_id,
  recorded_at = excluded.recorded_at,
  performance_score = excluded.performance_score,
  fcp_ms = excluded.fcp_ms,
  lcp_ms = excluded.lcp_ms,
  tbt_ms = excluded.tbt_ms,
  cls = excluded.cls,
  speed_index_ms = excluded.speed_index_ms;`);
      }
    }
  });

  // 4. Cron heartbeat in system_state
  statements.push("\n-- 4. Cron Heartbeat");
  statements.push(`INSERT INTO system_state (key, value_json, updated_at)
VALUES ('cron_heartbeat', json_object('lastCronRunAt', '${nowIso}'), '${nowIso}')
ON CONFLICT(key) DO UPDATE SET
  value_json = excluded.value_json,
  updated_at = excluded.updated_at;\n`);

  return statements.join("\n");
}

/**
 * Execute seed directly against a D1Database or better-sqlite3 database instance
 */
export async function seedDemoDatabase(db, baseTime = new Date()) {
  const sql = generateDemoSeedSql(baseTime);
  // Execute via D1 batch or sqlite exec
  if (typeof db.exec === "function") {
    db.exec(sql);
    return { ok: true, count: DEMO_SITES.length };
  } else if (typeof db.batch === "function") {
    // D1 batch accepts statements
    const chunks = sql.split(";\n").map(s => s.trim()).filter(s => s.length > 0);
    const statements = chunks.map(chunk => db.prepare(chunk));
    await db.batch(statements);
    return { ok: true, count: DEMO_SITES.length };
  } else {
    throw new Error("Unsupported database instance. Expected db.exec or db.batch");
  }
}

// CLI execution
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  const wantsSql = args.includes("--sql") || (!args.includes("--local") && !args.includes("--remote"));
  const outFileArg = args.find(a => a.startsWith("--out="));
  const outFile = outFileArg ? outFileArg.split("=")[1] : null;

  const sql = generateDemoSeedSql();

  if (outFile) {
    fs.writeFileSync(outFile, sql, "utf-8");
    console.log(`✓ Demo seed SQL successfully written to: ${outFile}`);
  } else if (wantsSql && !args.includes("--local") && !args.includes("--remote")) {
    console.log(sql);
  } else if (args.includes("--local")) {
    const tempSqlPath = path.join(ROOT_DIR, "scripts", ".demo-seed.tmp.sql");
    try {
      fs.writeFileSync(tempSqlPath, sql, "utf-8");
      console.log("Seeding local Cloudflare D1 database via Wrangler...");
      execSync(`npx wrangler d1 execute speedpulse-d1 --local --file=${tempSqlPath}`, {
        cwd: ROOT_DIR,
        stdio: "inherit"
      });
      console.log("✓ Local database seeded successfully with 6 public benchmark websites!");
    } finally {
      if (fs.existsSync(tempSqlPath)) fs.unlinkSync(tempSqlPath);
    }
  } else if (args.includes("--remote")) {
    const tempSqlPath = path.join(ROOT_DIR, "scripts", ".demo-seed.tmp.sql");
    try {
      fs.writeFileSync(tempSqlPath, sql, "utf-8");
      console.log("Seeding REMOTE Cloudflare D1 database via Wrangler...");
      execSync(`npx wrangler d1 execute speedpulse-d1 --remote --file=${tempSqlPath}`, {
        cwd: ROOT_DIR,
        stdio: "inherit"
      });
      console.log("✓ Remote database seeded successfully with 6 public benchmark websites!");
    } finally {
      if (fs.existsSync(tempSqlPath)) fs.unlinkSync(tempSqlPath);
    }
  }
}
