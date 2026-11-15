import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAttribution, deriveClientInfo, validateEventPayload } from '../shared/analytics.js';
import { getReportRange } from '../shared/reporting.js';

const baseEvent = {
  event_id: 'ev_abcdefghijklmnopqrstuvwxyz',
  event_name: 'page_view',
  browser_id: 'br_abcdefghijklmnopqrstuvwxyz',
  session_id: 'ss_abcdefghijklmnopqrstuvwxyz',
  page_path: '/',
  project_id: null,
  attribution: {},
  properties: {}
};

test('accepts a strict page-view payload', () => {
  const result = validateEventPayload(baseEvent);
  assert.equal(result.ok, true);
  assert.equal(result.value.eventType, 'page_view');
  assert.equal(result.value.attribution.referrerDomain, null);
});

test('rejects unknown fields and unsupported events', () => {
  assert.equal(validateEventPayload({ ...baseEvent, unexpected: 'data' }).ok, false);
  assert.equal(validateEventPayload({ ...baseEvent, event_name: 'scroll_depth' }).ok, false);
});

test('rejects sensitive or malformed attribution values', () => {
  assert.equal(validateEventPayload({ ...baseEvent, attribution: { utm_campaign: 'person@example.com' } }).ok, false);
  assert.equal(validateEventPayload({ ...baseEvent, attribution: { referrer_domain: 'https://example.com/path' } }).ok, false);
});

test('classifies UTM sources before inferred referrers', () => {
  assert.deepEqual(classifyAttribution({ utmSource: 'linkedin', referrerDomain: 'google.com' }), { kind: 'utm', label: 'linkedin' });
  assert.deepEqual(classifyAttribution({ utmSource: null, referrerDomain: 'www.linkedin.com' }), { kind: 'social', label: 'LinkedIn' });
  assert.deepEqual(classifyAttribution({ utmSource: null, referrerDomain: null }), { kind: 'unknown', label: null });
});

test('derives broad client categories without retaining raw user agent', () => {
  const client = deriveClientInfo('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', 'PH');
  assert.deepEqual(client, { deviceCategory: 'mobile', browserFamily: 'Safari', osFamily: 'iOS', countryCode: 'PH' });
});

test('limits dashboard custom ranges to the raw-event retention window', () => {
  const url = new URL('https://dashboard.example/api/dashboard?start=2026-01-01&end=2026-01-07');
  const range = getReportRange(url, 'Asia/Manila', Date.UTC(2026, 0, 8));
  assert.equal(range.end - range.start, 7 * 86_400_000);
  assert.throws(() => getReportRange(new URL('https://dashboard.example/api/dashboard?start=2026-01-01&end=2026-08-01'), 'Asia/Manila'), /180 days/);
});
