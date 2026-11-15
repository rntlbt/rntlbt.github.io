export const MAX_REQUEST_BYTES = 4096;

export const EVENT_DEFINITIONS = {
  page_view: { type: 'page_view', properties: [] },
  project_card_click: { type: 'interaction', properties: [] },
  screenshot_open: { type: 'interaction', properties: [] },
  github_profile_click: { type: 'interaction', properties: ['link_host', 'link_path'] },
  github_repository_click: { type: 'interaction', properties: ['link_host', 'link_path'] },
  linkedin_profile_click: { type: 'interaction', properties: ['link_host', 'link_path'] },
  social_profile_click: { type: 'interaction', properties: ['link_host', 'link_path'] },
  email_contact_click: { type: 'interaction', properties: [] },
  copy_email: { type: 'interaction', properties: [] },
  resume_download: { type: 'interaction', properties: ['link_host', 'link_path'] },
  outbound_link_click: { type: 'interaction', properties: ['link_host', 'link_path'] }
};

const ID_PATTERN = /^(?:br|ss|ev)_[A-Za-z0-9_-]{16,100}$/;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const PAGE_PATH_PATTERN = /^\/[A-Za-z0-9._~\/-]{0,159}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const UTM_VALUE_PATTERN = /^[A-Za-z0-9._~ -]{1,100}$/;
const LINK_PATH_PATTERN = /^\/[A-Za-z0-9._~\/-]{0,199}$/;

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers ?? {})
    }
  });
}

export function getAllowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(value => /^https?:\/\//.test(value));
}

export function corsHeaders(origin, env) {
  if (!origin || !getAllowedOrigins(env).includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin'
  };
}

export function isLikelyBot(userAgent = '') {
  return /bot|crawler|spider|slurp|headless|lighthouse|facebookexternalhit|prerender/i.test(userAgent);
}

export function validateEventPayload(input) {
  if (!isPlainObject(input)) return { ok: false, error: 'Payload must be a JSON object.' };

  const allowedKeys = new Set(['event_id', 'event_name', 'browser_id', 'session_id', 'page_path', 'project_id', 'attribution', 'properties']);
  if (Object.keys(input).some(key => !allowedKeys.has(key))) return { ok: false, error: 'Unsupported payload field.' };

  const definition = EVENT_DEFINITIONS[input.event_name];
  if (!definition) return { ok: false, error: 'Unsupported event.' };
  if (![input.event_id, input.browser_id, input.session_id].every(value => typeof value === 'string' && ID_PATTERN.test(value))) {
    return { ok: false, error: 'Invalid event, browser, or session identifier.' };
  }
  if (typeof input.page_path !== 'string' || !PAGE_PATH_PATTERN.test(input.page_path)) {
    return { ok: false, error: 'Invalid page path.' };
  }
  if (input.project_id != null && (typeof input.project_id !== 'string' || !PROJECT_ID_PATTERN.test(input.project_id))) {
    return { ok: false, error: 'Invalid project identifier.' };
  }

  const attribution = validateAttribution(input.attribution);
  if (!attribution.ok) return attribution;
  const properties = validateProperties(input.properties, definition.properties);
  if (!properties.ok) return properties;

  return {
    ok: true,
    value: {
      eventId: input.event_id,
      eventName: input.event_name,
      eventType: definition.type,
      browserId: input.browser_id,
      sessionId: input.session_id,
      pagePath: input.page_path,
      projectId: input.project_id ?? null,
      attribution: attribution.value,
      properties: properties.value
    }
  };
}

function validateAttribution(value) {
  if (value == null) return { ok: true, value: emptyAttribution() };
  if (!isPlainObject(value)) return { ok: false, error: 'Invalid attribution.' };
  const allowed = new Set(['referrer_domain', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']);
  if (Object.keys(value).some(key => !allowed.has(key))) return { ok: false, error: 'Unsupported attribution field.' };

  const referrerDomain = cleanDomain(value.referrer_domain);
  if (value.referrer_domain != null && !referrerDomain) return { ok: false, error: 'Invalid referrer domain.' };
  const cleaned = { referrerDomain };
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const item = value[key];
    if (item == null || item === '') {
      cleaned[toCamel(key)] = null;
      continue;
    }
    if (typeof item !== 'string' || !UTM_VALUE_PATTERN.test(item) || /@/.test(item)) {
      return { ok: false, error: `Invalid ${key}.` };
    }
    cleaned[toCamel(key)] = item.trim().toLowerCase();
  }
  return { ok: true, value: cleaned };
}

function validateProperties(value, allowedProperties) {
  if (value == null) return { ok: true, value: {} };
  if (!isPlainObject(value)) return { ok: false, error: 'Invalid event properties.' };
  if (Object.keys(value).some(key => !allowedProperties.includes(key))) return { ok: false, error: 'Unsupported event property.' };
  const properties = {};
  for (const key of allowedProperties) {
    if (value[key] == null) continue;
    if (key === 'link_host') {
      const domain = cleanDomain(value[key]);
      if (!domain) return { ok: false, error: 'Invalid link host.' };
      properties.link_host = domain;
    }
    if (key === 'link_path') {
      if (typeof value[key] !== 'string' || !LINK_PATH_PATTERN.test(value[key])) return { ok: false, error: 'Invalid link path.' };
      properties.link_path = value[key];
    }
  }
  return { ok: true, value: properties };
}

export function classifyAttribution(attribution) {
  if (attribution.utmSource) {
    return { kind: 'utm', label: attribution.utmSource };
  }
  const domain = attribution.referrerDomain;
  if (!domain) return { kind: 'unknown', label: null };

  const knownSources = [
    ['google.', 'search', 'Google'],
    ['bing.com', 'search', 'Bing'],
    ['github.com', 'developer', 'GitHub'],
    ['linkedin.com', 'social', 'LinkedIn'],
    ['facebook.com', 'social', 'Facebook'],
    ['instagram.com', 'social', 'Instagram'],
    ['tiktok.com', 'social', 'TikTok'],
    ['reddit.com', 'social', 'Reddit'],
    ['youtube.com', 'social', 'YouTube'],
    ['twitter.com', 'social', 'X / Twitter'],
    ['x.com', 'social', 'X / Twitter']
  ];
  const match = knownSources.find(([needle]) => domain === needle || domain.endsWith(`.${needle}`) || domain.includes(needle));
  return match ? { kind: match[1], label: match[2] } : { kind: 'referral', label: domain };
}

export function deriveClientInfo(userAgent = '', country = '') {
  const ua = String(userAgent);
  const isTablet = /ipad|tablet|playbook|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua));
  const deviceCategory = /mobile|iphone|ipod|android/i.test(ua) && !isTablet ? 'mobile' : isTablet ? 'tablet' : 'desktop';
  const browserFamily = /edg\//i.test(ua) ? 'Edge'
    : /firefox\//i.test(ua) ? 'Firefox'
      : /chrome\//i.test(ua) || /crios\//i.test(ua) ? 'Chrome'
        : /safari\//i.test(ua) ? 'Safari'
          : 'Other';
  const osFamily = /windows/i.test(ua) ? 'Windows'
    : /android/i.test(ua) ? 'Android'
      : /iphone|ipad|ipod/i.test(ua) ? 'iOS'
        : /mac os|macintosh/i.test(ua) ? 'macOS'
          : /linux/i.test(ua) ? 'Linux'
            : 'Other';
  return {
    deviceCategory,
    browserFamily,
    osFamily,
    countryCode: /^[A-Z]{2}$/.test(country) ? country : 'Unknown'
  };
}

export function emptyAttribution() {
  return {
    referrerDomain: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmContent: null,
    utmTerm: null
  };
}

function cleanDomain(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/^www\./, '');
  return DOMAIN_PATTERN.test(normalized) ? normalized : null;
}

function toCamel(value) {
  return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
