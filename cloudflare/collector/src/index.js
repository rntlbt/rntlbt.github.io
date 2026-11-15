import {
  MAX_REQUEST_BYTES,
  classifyAttribution,
  corsHeaders,
  deriveClientInfo,
  isLikelyBot,
  json,
  validateEventPayload
} from '../../shared/analytics.js';

const DAY_MS = 86_400_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS' && url.pathname === '/v1/events') {
      return cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });
    }

    if (url.pathname !== '/v1/events' || request.method !== 'POST') {
      return json({ error: 'Not found.' }, { status: 404 });
    }
    if (!cors) return json({ error: 'Origin is not allowed.' }, { status: 403 });
    if (isLikelyBot(request.headers.get('user-agent'))) {
      return json({ accepted: false }, { status: 202, headers: cors });
    }

    const contentLength = Number(request.headers.get('content-length') ?? 0);
    if (contentLength > MAX_REQUEST_BYTES) return json({ error: 'Payload too large.' }, { status: 413, headers: cors });

    let payload;
    try {
      const body = await request.text();
      if (body.length > MAX_REQUEST_BYTES) return json({ error: 'Payload too large.' }, { status: 413, headers: cors });
      payload = JSON.parse(body);
    } catch {
      return json({ error: 'Invalid JSON.' }, { status: 400, headers: cors });
    }

    const validated = validateEventPayload(payload);
    if (!validated.ok) return json({ error: validated.error }, { status: 400, headers: cors });

    try {
      const result = await recordEvent(env, request, validated.value);
      return json(result, { status: result.duplicate ? 200 : 202, headers: cors });
    } catch (error) {
      console.error('Analytics event write failed', error);
      return json({ error: 'Unable to record event.' }, { status: 503, headers: cors });
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runRetention(env));
  }
};

export async function recordEvent(env, request, event) {
  const now = Date.now();
  const existing = await env.DB.prepare('SELECT event_id FROM analytics_events WHERE event_id = ? LIMIT 1').bind(event.eventId).first();
  if (existing) return { accepted: true, duplicate: true };

  const existingBrowser = await env.DB.prepare('SELECT browser_id FROM analytics_browsers WHERE browser_id = ? LIMIT 1').bind(event.browserId).first();
  const source = classifyAttribution(event.attribution);
  const client = deriveClientInfo(request.headers.get('user-agent'), request.cf?.country);

  await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO analytics_browsers (browser_id, first_seen_at, last_seen_at)
      VALUES (?, ?, ?)
    `).bind(event.browserId, now, now),
    env.DB.prepare(`
      INSERT OR IGNORE INTO analytics_sessions (
        session_id, browser_id, started_at, last_seen_at, entry_page_path, entry_project_id,
        source_kind, source_label, referrer_domain, utm_source, utm_medium, utm_campaign,
        utm_content, utm_term, device_category, browser_family, os_family, country_code, is_new_browser
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      event.sessionId, event.browserId, now, now, event.pagePath, event.projectId,
      source.kind, source.label, event.attribution.referrerDomain, event.attribution.utmSource,
      event.attribution.utmMedium, event.attribution.utmCampaign, event.attribution.utmContent,
      event.attribution.utmTerm, client.deviceCategory, client.browserFamily, client.osFamily,
      client.countryCode, existingBrowser ? 0 : 1
    ),
    env.DB.prepare('UPDATE analytics_browsers SET last_seen_at = ? WHERE browser_id = ?').bind(now, event.browserId),
    env.DB.prepare('UPDATE analytics_sessions SET last_seen_at = ? WHERE session_id = ?').bind(now, event.sessionId),
    env.DB.prepare(`
      INSERT INTO analytics_events (
        event_id, event_type, event_name, occurred_at, browser_id, session_id, page_path, project_id, properties_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      event.eventId, event.eventType, event.eventName, now, event.browserId, event.sessionId,
      event.pagePath, event.projectId, JSON.stringify(event.properties)
    )
  ]);

  return { accepted: true, duplicate: false };
}

export async function runRetention(env, now = Date.now()) {
  const retentionDays = Math.min(365, Math.max(30, Number.parseInt(env.RETENTION_DAYS ?? '180', 10) || 180));
  const cutoff = now - retentionDays * DAY_MS;
  const yesterdayStart = startOfUtcDay(now - DAY_MS);
  const yesterdayEnd = yesterdayStart + DAY_MS;
  const reportDate = new Date(yesterdayStart).toISOString().slice(0, 10);

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO analytics_daily_rollups (
        report_date, page_views, sessions, estimated_unique_browsers, meaningful_interactions, generated_at
      )
      SELECT ?,
        COALESCE(SUM(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END), 0),
        COUNT(DISTINCT session_id),
        COUNT(DISTINCT browser_id),
        COALESCE(SUM(CASE WHEN event_type = 'interaction' THEN 1 ELSE 0 END), 0),
        ?
      FROM analytics_events
      WHERE occurred_at >= ? AND occurred_at < ?
      ON CONFLICT(report_date) DO UPDATE SET
        page_views = excluded.page_views,
        sessions = excluded.sessions,
        estimated_unique_browsers = excluded.estimated_unique_browsers,
        meaningful_interactions = excluded.meaningful_interactions,
        generated_at = excluded.generated_at
    `).bind(reportDate, now, yesterdayStart, yesterdayEnd),
    env.DB.prepare('DELETE FROM analytics_events WHERE occurred_at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM analytics_sessions WHERE last_seen_at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM analytics_browsers WHERE last_seen_at < ?').bind(cutoff)
  ]);
}

function startOfUtcDay(timestamp) {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
