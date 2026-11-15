/*
  Production setup: replace the empty string with your deployed public collector URL,
  for example: https://rntlbt-portfolio-collector.<your-workers-subdomain>.workers.dev/v1/events
  This URL is intentionally public. It is not a credential.
*/
window.PORTFOLIO_ANALYTICS_CONFIG = {
  collectorUrl: 'https://rntlbt-portfolio-collector.rntlbt-portfolio.workers.dev/v1/events',
  // Set to true where opt-in consent is required before analytics collection.
  requireConsent: false
};
