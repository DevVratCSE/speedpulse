PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  origin TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  mobile_frequency TEXT NOT NULL DEFAULT 'daily' CHECK (mobile_frequency IN ('daily','weekly','manual')),
  desktop_frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (desktop_frequency IN ('daily','weekly','manual')),
  mobile_next_check_at TEXT,
  desktop_next_check_at TEXT,
  mobile_last_status TEXT,
  mobile_last_error TEXT,
  mobile_last_run_at TEXT,
  desktop_last_status TEXT,
  desktop_last_error TEXT,
  desktop_last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(project_id, url)
);

CREATE TABLE IF NOT EXISTS test_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL CHECK (strategy IN ('mobile','desktop')),
  source TEXT NOT NULL CHECK (source IN ('manual','scheduled')),
  status TEXT NOT NULL CHECK (status IN ('running','success','failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  psi_fetch_time TEXT,
  lighthouse_version TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_run_id INTEGER NOT NULL UNIQUE REFERENCES test_runs(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL CHECK (strategy IN ('mobile','desktop')),
  recorded_at TEXT NOT NULL,
  performance_score INTEGER,
  accessibility_score INTEGER,
  seo_score INTEGER,
  best_practices_score INTEGER,
  fcp_ms REAL,
  lcp_ms REAL,
  tbt_ms REAL,
  cls REAL,
  speed_index_ms REAL,
  field_lcp_ms REAL,
  field_inp_ms REAL,
  field_cls REAL,
  field_data_source TEXT,
  field_period_start TEXT,
  field_period_end TEXT
);

CREATE TABLE IF NOT EXISTS site_latest (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL CHECK (strategy IN ('mobile','desktop')),
  test_run_id INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  recorded_at TEXT NOT NULL,
  performance_score INTEGER,
  accessibility_score INTEGER,
  seo_score INTEGER,
  best_practices_score INTEGER,
  fcp_ms REAL,
  lcp_ms REAL,
  tbt_ms REAL,
  cls REAL,
  speed_index_ms REAL,
  field_lcp_ms REAL,
  field_inp_ms REAL,
  field_cls REAL,
  field_data_source TEXT,
  field_period_start TEXT,
  field_period_end TEXT,
  PRIMARY KEY (site_id, strategy)
);

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_sites_project ON sites(project_id, active);
CREATE INDEX IF NOT EXISTS idx_sites_mobile_due ON sites(active, mobile_next_check_at);
CREATE INDEX IF NOT EXISTS idx_sites_desktop_due ON sites(active, desktop_next_check_at);
CREATE INDEX IF NOT EXISTS idx_runs_site_time ON test_runs(site_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON test_runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_history ON metrics(site_id, strategy, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_annotations_site ON annotations(site_id, created_at DESC);
