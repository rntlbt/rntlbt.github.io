(() => {
  const config = window.PORTFOLIO_ANALYTICS_CONFIG ?? {};
  const endpoint = typeof config.collectorUrl === 'string' ? config.collectorUrl.trim() : '';
  const SESSION_TIMEOUT = 30 * 60 * 1000;
  const browserStorageKey = 'portfolio_browser_id';
  const sessionStorageKey = 'portfolio_session';
  const debugStorageKey = 'portfolio_analytics_debug';
  const ignoreStorageKey = 'portfolio_ignore';
  const consentStorageKey = 'portfolio_analytics_consent';

  window.PortfolioAnalytics = {
    grantConsent() { writeLocal(consentStorageKey, 'granted'); window.location.reload(); },
    revokeConsent() { writeLocal(consentStorageKey, 'denied'); window.location.reload(); }
  };

  if (!endpoint || shouldIgnore() || isLocalDevelopment()) return;
  if (config.requireConsent && readLocal(consentStorageKey) !== 'granted') {
    if (readLocal(consentStorageKey) !== 'denied') renderConsentPrompt();
    return;
  }

  const browserId = getOrCreateBrowserId();
  const session = getOrCreateSession();
  if (!browserId || !session) return;

  track('page_view');
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-analytics-event], a[href], button');
    if (!target) return;
    const eventName = resolveEventName(target);
    if (!eventName) return;
    track(eventName, target);
  }, { capture: true });

  function track(eventName, element = null) {
    const currentSession = touchSession();
    if (!currentSession) return;
    const eventId = createId('ev');
    const payload = {
      event_id: eventId,
      event_name: eventName,
      browser_id: browserId,
      session_id: currentSession.id,
      page_path: pagePath(),
      project_id: projectId(element),
      attribution: attribution(),
      properties: eventProperties(element)
    };
    send(payload);
  }

  function send(payload) {
    const body = JSON.stringify(payload);
    fetch(endpoint, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body
    }).then(response => {
      if (!response.ok && response.status >= 500) retry(body);
    }).catch(() => retry(body));
  }

  function retry(body) {
    window.setTimeout(() => {
      fetch(endpoint, {
        method: 'POST', mode: 'cors', credentials: 'omit', keepalive: true,
        headers: { 'content-type': 'application/json' }, body
      }).catch(() => {});
    }, 1200);
  }

  function resolveEventName(element) {
    if (element.dataset.analyticsEvent) return element.dataset.analyticsEvent;
    if (element.classList.contains('project-card')) return 'project_card_click';
    if (element.classList.contains('screenshot-button')) return 'screenshot_open';
    if (element.matches('.copy-button')) return element.dataset.copyLabel === 'email' ? 'copy_email' : null;
    if (!element.matches('a[href]')) return null;
    const href = element.getAttribute('href');
    if (href?.startsWith('mailto:')) return 'email_contact_click';
    if (element.hasAttribute('download')) return 'resume_download';
    const link = safeUrl(href);
    if (!link || link.origin === window.location.origin) return null;
    if (link.hostname === 'github.com' || link.hostname.endsWith('.github.com')) {
      return link.pathname.split('/').filter(Boolean).length > 1 ? 'github_repository_click' : 'github_profile_click';
    }
    if (link.hostname.includes('linkedin.com')) return 'linkedin_profile_click';
    if (/facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|youtube\.com|reddit\.com/i.test(link.hostname)) return 'social_profile_click';
    return 'outbound_link_click';
  }

  function eventProperties(element) {
    if (!element?.matches('a[href]')) return {};
    const link = safeUrl(element.getAttribute('href'));
    if (!link || link.protocol === 'mailto:') return {};
    return { link_host: link.hostname.replace(/^www\./, ''), link_path: link.pathname || '/' };
  }

  function pagePath() {
    const raw = window.location.pathname || '/';
    return raw === '/index.html' ? '/' : raw;
  }

  function projectId(element = null) {
    const explicit = element?.dataset?.projectId;
    if (/^[a-z0-9][a-z0-9_-]{0,79}$/.test(explicit ?? '')) return explicit;
    const value = new URLSearchParams(window.location.search).get('id');
    return /^[a-z0-9][a-z0-9_-]{0,79}$/.test(value ?? '') ? value : null;
  }

  function attribution() {
    const params = new URLSearchParams(window.location.search);
    return {
      referrer_domain: referrerDomain(),
      utm_source: validUtm(params.get('utm_source')),
      utm_medium: validUtm(params.get('utm_medium')),
      utm_campaign: validUtm(params.get('utm_campaign')),
      utm_content: validUtm(params.get('utm_content')),
      utm_term: validUtm(params.get('utm_term'))
    };
  }

  function referrerDomain() {
    try {
      const referrer = document.referrer ? new URL(document.referrer) : null;
      if (!referrer || referrer.origin === window.location.origin) return null;
      return referrer.hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return null;
    }
  }

  function validUtm(value) {
    if (!value || !/^[A-Za-z0-9._~ -]{1,100}$/.test(value) || value.includes('@')) return null;
    return value.trim().toLowerCase();
  }

  function getOrCreateBrowserId() {
    const existing = readLocal(browserStorageKey);
    if (isId(existing, 'br')) return existing;
    const created = createId('br');
    writeLocal(browserStorageKey, created);
    return created;
  }

  function getOrCreateSession() {
    const existing = readSession();
    if (existing && isId(existing.id, 'ss') && Date.now() - existing.lastActivity < SESSION_TIMEOUT) return existing;
    const created = { id: createId('ss'), lastActivity: Date.now() };
    writeSession(created);
    return created;
  }

  function touchSession() {
    const session = getOrCreateSession();
    session.lastActivity = Date.now();
    writeSession(session);
    return session;
  }

  function shouldIgnore() {
    return readLocal(ignoreStorageKey) === '1';
  }

  function renderConsentPrompt() {
    const prompt = document.createElement('section');
    prompt.setAttribute('role', 'dialog');
    prompt.setAttribute('aria-label', 'Analytics preference');
    prompt.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;max-width:390px;padding:16px;border:1px solid rgba(255,255,255,.1);border-radius:16px;background:#1e1e1e;color:#f0f0f0;box-shadow:0 24px 80px rgba(0,0,0,.32);font:14px/1.5 Inter,system-ui,sans-serif;';
    prompt.innerHTML = '<strong style="display:block;margin-bottom:6px">Analytics preference</strong><p style="margin:0 0 12px;color:#a0a0a0">Help improve this portfolio with privacy-conscious, first-party analytics.</p><a href="privacy.html" style="color:#00ffcc">Privacy details</a><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button type="button" data-analytics-decline style="padding:8px 12px;border:1px solid rgba(255,255,255,.1);border-radius:999px;background:transparent;color:#f0f0f0">Decline</button><button type="button" data-analytics-accept style="padding:8px 12px;border:1px solid #00ffcc;border-radius:999px;background:#00ffcc;color:#121212;font-weight:800">Allow analytics</button></div>';
    prompt.querySelector('[data-analytics-accept]').addEventListener('click', () => window.PortfolioAnalytics.grantConsent());
    prompt.querySelector('[data-analytics-decline]').addEventListener('click', () => window.PortfolioAnalytics.revokeConsent());
    document.body.appendChild(prompt);
  }

  function isLocalDevelopment() {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
    return local && readLocal(debugStorageKey) !== '1';
  }

  function safeUrl(value) {
    try { return new URL(value, window.location.href); } catch { return null; }
  }

  function createId(prefix) {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    return `${prefix}_${Array.from(bytes, byte => byte.toString(36).padStart(2, '0')).join('')}`;
  }

  function isId(value, prefix) {
    return new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,100}$`).test(value ?? '');
  }

  function readLocal(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  }

  function writeLocal(key, value) {
    try { window.localStorage.setItem(key, value); } catch {}
  }

  function readSession() {
    try { return JSON.parse(window.sessionStorage.getItem(sessionStorageKey) ?? 'null'); } catch { return null; }
  }

  function writeSession(value) {
    try { window.sessionStorage.setItem(sessionStorageKey, JSON.stringify(value)); } catch {}
  }
})();
