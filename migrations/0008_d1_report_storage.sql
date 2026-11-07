-- ================================================================
-- SpeedPulse Next
-- Migration 0008
--
-- D1-backed report payload storage for zero-card deployment.
--
-- Provides 100,000 writes/day (100x KV's 1,000 writes/day limit)
-- with zero credit card required and strong consistency.
-- ================================================================

CREATE TABLE IF NOT EXISTS report_payloads (
  storage_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_payloads_created_at ON report_payloads(created_at);
