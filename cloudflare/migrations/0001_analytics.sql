-- Shared migration history for both Workers. Apply this only once, using the collector config.
-- All timestamps are Unix milliseconds in UTC.
CREATE TABLE IF NOT EXISTS analytics_browsers (
  browser_id TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_sessions (
  session_id TEXT PRIMARY KEY,
  browser_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  entry_page_path TEXT NOT NULL,
  entry_project_id TEXT,
  source_kind TEXT NOT NULL,
  source_label TEXT,
  referrer_domain TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  device_category TEXT NOT NULL,
  browser_family TEXT NOT NULL,
  os_family TEXT NOT NULL,
  country_code TEXT NOT NULL,
  is_new_browser INTEGER NOT NULL CHECK (is_new_browser IN (0, 1))
);

CREATE TABLE IF NOT EXISTS analytics_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('page_view', 'interaction')),
  event_name TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  browser_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  page_path TEXT NOT NULL,
  project_id TEXT,
  properties_json TEXT NOT NULL DEFAULT '{}'
);

-- Retains non-identifying, daily totals after raw records expire. Do not add daily unique values
-- together to make a lifetime-unique metric.
CREATE TABLE IF NOT EXISTS analytics_daily_rollups (
  report_date TEXT PRIMARY KEY,
  page_views INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  estimated_unique_browsers INTEGER NOT NULL,
  meaningful_interactions INTEGER NOT NULL,
  generated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_occurred_type
  ON analytics_events (occurred_at, event_type);
CREATE INDEX IF NOT EXISTS idx_events_session_occurred
  ON analytics_events (session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_page_occurred
  ON analytics_events (page_path, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_project_occurred
  ON analytics_events (project_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_sessions_started
  ON analytics_sessions (started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_source
  ON analytics_sessions (source_kind, source_label, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_browser
  ON analytics_sessions (browser_id, started_at);
