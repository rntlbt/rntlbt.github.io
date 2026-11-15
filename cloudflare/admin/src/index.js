import { json } from '../../shared/analytics.js';
import { getDashboardReport, getReportRange } from '../../shared/reporting.js';
import { dashboardHtml } from './dashboard.js';

export default {
  async fetch(request, env, ctx) {
    const authorization = await authorizeOwner(env, ctx);
    if (!authorization.ok) return authorization.response;

    const url = new URL(request.url);
    if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, { status: 405, headers: { allow: 'GET' } });

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(dashboardHtml(), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex, nofollow, noarchive'
        }
      });
    }

    if (url.pathname === '/api/dashboard') {
      try {
        const timezone = validTimeZone(env.DASHBOARD_TIMEZONE) ? env.DASHBOARD_TIMEZONE : 'Asia/Manila';
        const range = getReportRange(url, timezone);
        const report = await getDashboardReport(env.DB, range);
        report.retention_days = safeRetention(env.RAW_RETENTION_DAYS);
        return json(report);
      } catch (error) {
        if (error instanceof RangeError || /range|dates|timezone/i.test(error.message)) {
          return json({ error: error.message }, { status: 400 });
        }
        console.error('Analytics reporting query failed', error);
        return json({ error: 'Analytics dashboard is temporarily unavailable.' }, { status: 503 });
      }
    }

    if (url.pathname === '/api/health') {
      try {
        await env.DB.prepare('SELECT 1 AS healthy').first();
        return json({ status: 'ok', database: 'available' });
      } catch (error) {
        console.error('Analytics health check failed', error);
        return json({ status: 'unavailable' }, { status: 503 });
      }
    }

    return json({ error: 'Not found.' }, { status: 404 });
  }
};

async function authorizeOwner(env, ctx) {
  const ownerEmail = String(env.OWNER_EMAIL ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    return { ok: false, response: json({ error: 'Dashboard owner identity is not configured.' }, { status: 503 }) };
  }
  if (!ctx?.access) {
    return { ok: false, response: json({ error: 'Cloudflare Access authentication is required.' }, { status: 403 }) };
  }
  const identity = await ctx.access.getIdentity();
  if (String(identity?.email ?? '').trim().toLowerCase() !== ownerEmail) {
    return { ok: false, response: json({ error: 'This identity is not authorized for analytics.' }, { status: 403 }) };
  }
  return { ok: true };
}

function validTimeZone(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function safeRetention(value) {
  return Math.min(365, Math.max(30, Number.parseInt(value ?? '180', 10) || 180));
}
