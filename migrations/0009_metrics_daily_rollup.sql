-- ================================================================
-- SpeedPulse Next
-- Migration 0009
--
-- Daily rollups for long-term metrics retention and fast history rendering.
-- Retains median and p75 metrics per site, strategy, and day.
-- Enables raw 90-day data pruning while preserving 1Y and all-time history.
-- ================================================================

CREATE TABLE IF NOT EXISTS metrics_daily_rollup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL CHECK (strategy IN ('mobile', 'desktop')),
  rollup_date TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  total_runs INTEGER NOT NULL DEFAULT 0,
  successful_runs INTEGER NOT NULL DEFAULT 0,

  -- Summary category score medians
  performance_score INTEGER,
  accessibility_score INTEGER,
  seo_score INTEGER,
  best_practices_score INTEGER,

  -- Summary category score 75th percentiles (p75)
  performance_score_p75 INTEGER,
  accessibility_score_p75 INTEGER,
  seo_score_p75 INTEGER,
  best_practices_score_p75 INTEGER,

  -- Core Web Vitals & diagnostic lab metric medians
  fcp_ms REAL,
  lcp_ms REAL,
  tbt_ms REAL,
  cls REAL,
  speed_index_ms REAL,

  -- Core Web Vitals & diagnostic lab metric 75th percentiles (p75)
  fcp_ms_p75 REAL,
  lcp_ms_p75 REAL,
  tbt_ms_p75 REAL,
  cls_p75 REAL,
  speed_index_ms_p75 REAL,

  -- CrUX field data
  field_lcp_ms REAL,
  field_inp_ms REAL,
  field_cls REAL,
  field_data_source TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  UNIQUE(site_id, strategy, rollup_date)
);

CREATE INDEX IF NOT EXISTS idx_rollup_site_strat_recorded
ON metrics_daily_rollup(site_id, strategy, recorded_at ASC);

CREATE INDEX IF NOT EXISTS idx_rollup_site_strat_date
ON metrics_daily_rollup(site_id, strategy, rollup_date DESC);
