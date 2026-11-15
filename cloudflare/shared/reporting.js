const DAY_MS = 86_400_000;

export function getReportRange(url, timezone = 'Asia/Manila', now = Date.now()) {
  const customStart = url.searchParams.get('start');
  const customEnd = url.searchParams.get('end');
  if (customStart || customEnd) {
    if (!isDate(customStart) || !isDate(customEnd)) throw new Error('Custom dates must use YYYY-MM-DD.');
    const startTime = parseTime(url.searchParams.get('start_time'));
    const endTime = parseTime(url.searchParams.get('end_time'));
    const start = startOfDayInZone(customStart, timezone) + (startTime ?? 0) * 60_000;
    // A time picker has minute precision, so include the full selected end minute.
    const end = endTime == null
      ? startOfDayInZone(addDays(customEnd, 1), timezone)
      : startOfDayInZone(customEnd, timezone) + (endTime + 1) * 60_000;
    if (end <= start || end - start > 180 * DAY_MS) throw new Error('Custom range must be between 1 and 180 days.');
    return { key: 'custom', start, end, previousStart: start - (end - start), previousEnd: start, timezone };
  }

  const key = url.searchParams.get('range') ?? '30d';
  const days = { today: 1, '7d': 7, '30d': 30, '90d': 90 }[key];
  if (!days) throw new Error('Unsupported range.');
  const end = startOfDayInZone(addDays(zonedDate(now, timezone), 1), timezone);
  const start = days === 1 ? startOfDayInZone(zonedDate(now, timezone), timezone) : end - days * DAY_MS;
  return { key, start, end, previousStart: start - (end - start), previousEnd: start, timezone };
}

export async function getDashboardReport(db, range) {
  const offsetMs = timezoneOffsetMinutes(range.timezone, range.end - 1) * 60_000;
  const statements = [
    summaryStatement(db, range.start, range.end),
    summaryStatement(db, range.previousStart, range.previousEnd),
    db.prepare(`
      SELECT date((occurred_at + ?) / 1000, 'unixepoch') AS day,
        COUNT(*) AS page_views,
        COUNT(DISTINCT session_id) AS sessions,
        COUNT(DISTINCT browser_id) AS estimated_unique_browsers
      FROM analytics_events
      WHERE event_name = 'page_view' AND occurred_at >= ? AND occurred_at < ?
      GROUP BY day ORDER BY day
    `).bind(offsetMs, range.start, range.end),
    db.prepare(`
      SELECT source_kind, COALESCE(source_label, 'Unattributed') AS source_label,
        COUNT(*) AS sessions
      FROM analytics_sessions
      WHERE started_at >= ? AND started_at < ?
      GROUP BY source_kind, source_label
      ORDER BY sessions DESC, source_label ASC LIMIT 20
    `).bind(range.start, range.end),
    db.prepare(`
      SELECT COALESCE(referrer_domain, 'Unattributed') AS referrer_domain, COUNT(*) AS sessions
      FROM analytics_sessions
      WHERE started_at >= ? AND started_at < ? AND referrer_domain IS NOT NULL
      GROUP BY referrer_domain ORDER BY sessions DESC, referrer_domain ASC LIMIT 15
    `).bind(range.start, range.end),
    db.prepare(`
      SELECT utm_source, COALESCE(utm_medium, 'Unspecified') AS utm_medium,
        COALESCE(utm_campaign, 'Unspecified') AS utm_campaign, COUNT(*) AS sessions
      FROM analytics_sessions
      WHERE started_at >= ? AND started_at < ? AND utm_source IS NOT NULL
      GROUP BY utm_source, utm_medium, utm_campaign
      ORDER BY sessions DESC LIMIT 20
    `).bind(range.start, range.end),
    db.prepare(`
      SELECT page_path, COUNT(*) AS page_views, COUNT(DISTINCT browser_id) AS estimated_unique_browsers,
        COUNT(DISTINCT session_id) AS sessions
      FROM analytics_events
      WHERE event_name = 'page_view' AND occurred_at >= ? AND occurred_at < ?
      GROUP BY page_path ORDER BY page_views DESC, page_path ASC LIMIT 20
    `).bind(range.start, range.end),
    db.prepare(`
      SELECT project_id, COUNT(*) AS page_views, COUNT(DISTINCT browser_id) AS estimated_unique_browsers,
        COUNT(DISTINCT session_id) AS sessions
      FROM analytics_events
      WHERE event_name = 'page_view' AND project_id IS NOT NULL AND occurred_at >= ? AND occurred_at < ?
      GROUP BY project_id ORDER BY page_views DESC, project_id ASC LIMIT 20
    `).bind(range.start, range.end),
    db.prepare(`
      SELECT e.project_id, COALESCE(s.source_label, 'Unattributed') AS source_label,
        s.source_kind, COUNT(DISTINCT e.session_id) AS sessions
      FROM analytics_events e
      JOIN analytics_sessions s ON s.session_id = e.session_id
      WHERE e.event_name = 'page_view' AND e.project_id IS NOT NULL
        AND e.occurred_at >= ? AND e.occurred_at < ?
      GROUP BY e.project_id, s.source_kind, s.source_label
      ORDER BY sessions DESC LIMIT 30
    `).bind(range.start, range.end),
    breakdownStatement(db, 'device_category', range.start, range.end),
    breakdownStatement(db, 'browser_family', range.start, range.end),
    breakdownStatement(db, 'os_family', range.start, range.end),
    breakdownStatement(db, 'country_code', range.start, range.end),
    db.prepare(`
      SELECT CASE WHEN is_new_browser = 1 THEN 'New browsers' ELSE 'Returning browsers' END AS label,
        COUNT(*) AS sessions
      FROM analytics_sessions WHERE started_at >= ? AND started_at < ?
      GROUP BY is_new_browser ORDER BY is_new_browser DESC
    `).bind(range.start, range.end),
    db.prepare(`
      SELECT entry_page_path AS page_path, COUNT(*) AS sessions
      FROM analytics_sessions WHERE started_at >= ? AND started_at < ?
      GROUP BY entry_page_path ORDER BY sessions DESC, page_path ASC LIMIT 15
    `).bind(range.start, range.end),
    db.prepare(`
      SELECT strftime('%H', (occurred_at + ?) / 1000, 'unixepoch') AS hour,
        COUNT(DISTINCT session_id) AS sessions
      FROM analytics_events WHERE occurred_at >= ? AND occurred_at < ?
      GROUP BY hour ORDER BY hour
    `).bind(offsetMs, range.start, range.end),
    db.prepare(`
      SELECT event_name, page_path, project_id, COUNT(*) AS interactions
      FROM analytics_events
      WHERE event_type = 'interaction' AND occurred_at >= ? AND occurred_at < ?
      GROUP BY event_name, page_path, project_id
      ORDER BY interactions DESC, event_name ASC LIMIT 30
    `).bind(range.start, range.end),
    db.prepare(`
      SELECT MIN(occurred_at) AS first_event_at, MAX(occurred_at) AS latest_event_at,
        COUNT(*) AS raw_event_count
      FROM analytics_events
    `)
  ];

  const results = await db.batch(statements);
  return {
    range: { key: range.key, start: range.start, end: range.end, timezone: range.timezone },
    summary: row(results[0]),
    previousSummary: row(results[1]),
    dailyTraffic: rows(results[2]),
    sources: rows(results[3]),
    referrers: rows(results[4]),
    campaigns: rows(results[5]),
    pages: rows(results[6]),
    projects: rows(results[7]),
    projectSources: rows(results[8]),
    deviceCategories: rows(results[9]),
    browsers: rows(results[10]),
    operatingSystems: rows(results[11]),
    countries: rows(results[12]),
    newReturning: rows(results[13]),
    landingPages: rows(results[14]),
    activityByHour: rows(results[15]),
    interactions: rows(results[16]),
    diagnostics: row(results[17])
  };
}

function summaryStatement(db, start, end) {
  return db.prepare(`
    SELECT
      COUNT(DISTINCT browser_id) AS estimated_unique_visitors,
      COUNT(DISTINCT session_id) AS total_sessions,
      SUM(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END) AS total_page_views,
      SUM(CASE WHEN event_type = 'interaction' THEN 1 ELSE 0 END) AS meaningful_interactions
    FROM analytics_events WHERE occurred_at >= ? AND occurred_at < ?
  `).bind(start, end);
}

function breakdownStatement(db, column, start, end) {
  return db.prepare(`
    SELECT ${column} AS label, COUNT(*) AS sessions
    FROM analytics_sessions WHERE started_at >= ? AND started_at < ?
    GROUP BY ${column} ORDER BY sessions DESC, label ASC LIMIT 15
  `).bind(start, end);
}

function rows(result) {
  return result?.results ?? [];
}

function row(result) {
  return rows(result)[0] ?? {};
}

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function parseTime(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error('Custom times must use HH:MM.');
  }
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function addDays(isoDate, amount) {
  const value = new Date(`${isoDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function zonedDate(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function startOfDayInZone(isoDate, timezone) {
  const [year, month, day] = isoDate.split('-').map(Number);
  let value = Date.UTC(year, month - 1, day);
  value -= timezoneOffsetMinutes(timezone, value) * 60_000;
  value -= timezoneOffsetMinutes(timezone, value) * 60_000 - timezoneOffsetMinutes(timezone, Date.UTC(year, month - 1, day)) * 60_000;
  return value;
}

function timezoneOffsetMinutes(timezone, timestamp) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(timestamp))
    .find(item => item.type === 'timeZoneName')?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(part ?? '');
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '+' ? minutes : -minutes;
}
