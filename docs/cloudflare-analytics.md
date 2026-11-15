# Cloudflare analytics deployment guide

This repository keeps the public portfolio on GitHub Pages and adds two independent Cloudflare Workers:

- `cloudflare/collector`: public, write-only analytics collector at `POST /v1/events`.
- `cloudflare/admin`: private analytics dashboard and reporting API.
- `cloudflare/migrations/0001_analytics.sql`: the single shared D1 migration history.

Both Workers are already configured to bind the existing production D1 database:

```text
name: rntlbt-portfolio-db
id:   030b0c55-0129-4c01-9d19-f2a43c549a42
```

No new database is created by this project.

## Inspection summary

The portfolio is a static, no-build HTML/CSS/JavaScript site. `index.html` renders project cards from `js/projects-data.js`; `project.html?id=<project-id>` renders separate project detail pages. There were no existing dependencies, server routes, package configuration, or deployment configuration in the repository.

The design system is represented by CSS tokens in `css/styles.css`: `#121212` base, `#1e1e1e` surfaces, `#f0f0f0` text, `#a0a0a0` muted text, `#00ffcc` accent, Inter/system typography, 20-28px rounded panels, 1200px content width, bordered dark cards, and subtle hover/reveal motion. The private dashboard uses the same colors, hierarchy, density, borders, and responsive breakpoints. The public site is not redesigned.

Tracked public interactions are page views, project-card clicks, project screenshot opens, GitHub profile/repository links, LinkedIn/social links, email clicks, email-copy actions, resume downloads, and future external links. Existing homepage anchor navigation and scrolling are deliberately not tracked as page views.

## Security and privacy model

The browser sends only a limited JSON event to the public collector. The collector rejects oversized payloads, unapproved origins, unknown events/properties, malformed identifiers, malformed attribution, and common bot user agents. It permits production CORS only from `https://rntlbt.github.io`; localhost origins exist solely in the `development` Worker environment. It uses parameterized D1 queries and event IDs to make retried writes idempotent.

The collector has no reporting, query, configuration, or administrative route. CORS is not authentication and cannot stop a malicious non-browser client from fabricating a request, so input validation, low payload limits, duplicate handling, bot heuristics, and aggregate-only reporting are defense-in-depth measures rather than a claim of perfect abuse prevention.

The dashboard Worker fails closed. Every request requires both Cloudflare Access (`ctx.access`) and an identity whose email matches the private `OWNER_EMAIL` Worker secret. Deploying the Worker before Access or the secret is configured returns `403` or `503`; it does not expose analytics data. Do not add a password page or client-side authentication.

Raw IP addresses, full referrer URLs, URL query strings other than approved UTM values, precise location, raw user agents, form contents, and clipboard contents are never stored. Browser IDs are random local identifiers, not fingerprints. The public disclosure is at `privacy.html`.

## Data definitions and retention

- A browser ID is a random value in `localStorage`; it estimates a unique browser, not a confirmed person.
- A session ID is stored in `sessionStorage` and is replaced after 30 minutes of inactivity.
- A page view is one initial document load. Refreshes are legitimate new page views; internal anchor navigation is not.
- A project-card click is an interaction, separate from the resulting project page view.
- Session acquisition is set only when a session is first recorded. It is never overwritten while the visitor moves inside the portfolio.
- An explicit `utm_source` wins over referrer classification. Missing referrers are `unknown`, not assumed to be direct traffic.
- Referrer domain classifications include Google/Bing, GitHub, LinkedIn, Facebook, Instagram, TikTok, Reddit, YouTube, and X/Twitter when a referrer is available.
- Country comes from Cloudflare request metadata, and device/browser/OS are broad user-agent classifications. All can be unknown or approximate.
- Raw browser, session, and event records are retained for 180 days by default. The collector's daily cron writes a daily aggregate for the previous UTC day, then removes stale raw records. Daily estimated-unique values must never be added to create a lifetime-unique total.

The public owner opt-out is persistent per browser:

```js
localStorage.setItem('portfolio_ignore', '1')
```

To re-enable it:

```js
localStorage.removeItem('portfolio_ignore')
```

The tracker does not send from localhost by default. For an intentional local tracking test only, set `localStorage.setItem('portfolio_analytics_debug', '1')` and remove it afterward.

Where an applicable jurisdiction requires opt-in analytics consent, set `requireConsent: true` in `js/analytics-config.js`. The tracker will remain off until the visitor explicitly accepts the built-in prompt. A declined choice is stored locally and can be changed with `window.PortfolioAnalytics.grantConsent()` or `window.PortfolioAnalytics.revokeConsent()`.

## One-time local setup

Run these commands from the repository root, `D:\sir aaron\portfolio\aaron-portfolio`:

```powershell
npm.cmd install
npm.cmd run check
npm.cmd test
npm.cmd run db:migrate:local
```

The last command applies the migration to a local D1 store at `.wrangler/analytics-local`; it does not touch production.

The private dashboard supports whole-day presets and a custom start/end date. Optional custom start and end times can narrow a range to part of a day; the selected end minute is included. These inputs use the dashboard timezone, which defaults to `Asia/Manila`.

For local collector testing, use one terminal:

```powershell
npm.cmd run collector:dev
```

For the private dashboard, copy the ignored local owner identity file, replace the example email with your own, then use another terminal:

```powershell
Copy-Item cloudflare\admin\.dev.vars.example cloudflare\admin\.dev.vars
npm.cmd run dashboard:dev
```

The collector listens on `http://127.0.0.1:8787` and the dashboard normally listens on the next available port. Both use the same persisted local D1 folder. Visit `/api/dashboard?range=30d` on the dashboard to confirm reporting. The dashboard's Wrangler configuration supplies a simulated Access identity only for local development; it is not production authentication.

To test the public tracker with a local static server, temporarily set `collectorUrl` in `js/analytics-config.js` to `http://127.0.0.1:8787/v1/events`, serve this directory on port 5500, set the local debug key above, and visit the page. Restore `collectorUrl` to an empty string and remove the debug key before committing if you do not yet have a deployed collector.

## Production deployment: owner steps

These commands require the owner's existing Wrangler login. They were not run by Codex against the Cloudflare account.

1. Confirm the exact existing database. This must return the supplied ID, and there must be no replacement database:

   ```powershell
   npx.cmd wrangler d1 list
   ```

2. Review the pending migration, then apply it once to the existing remote D1 database:

   ```powershell
   npx.cmd wrangler d1 migrations list rntlbt-portfolio-db --config cloudflare/collector/wrangler.jsonc --env=""
   npm.cmd run db:migrate:remote
   ```

   Expected result: `0001_analytics.sql` is applied to `030b0c55-0129-4c01-9d19-f2a43c549a42`.

3. Deploy the public collector:

   ```powershell
   npx.cmd wrangler deploy --config cloudflare/collector/wrangler.jsonc --env=""
   ```

   Wrangler prints the real collector URL. Keep it for step 7. This Worker is intentionally public only at `POST /v1/events`.

4. Deploy the dashboard once. It is safe to deploy before its secret because the Worker returns `503` until the owner identity is configured:

   ```powershell
   npx.cmd wrangler deploy --config cloudflare/admin/wrangler.jsonc --env=""
   npx.cmd wrangler secret put OWNER_EMAIL --config cloudflare/admin/wrangler.jsonc --env=""
   ```

   At the prompt, enter the exact email address that Cloudflare Access will authorize. Do not put this value in `wrangler.jsonc`, `analytics-config.js`, Git, or a committed `.dev.vars` file.

5. Configure Cloudflare Access before using the dashboard. In Cloudflare, enable Zero Trust if prompted, then go to **Workers & Pages**, open the deployed `rntlbt-portfolio-analytics` Worker, open **Access**, choose **Protect this Worker behind Access**, select **All traffic**, and create an allow policy for only the same exact owner email used in `OWNER_EMAIL`. This protects the Worker’s production `workers.dev` URL, its dashboard HTML, and every `/api/*` response. Do not use a bypass policy on this Worker.

6. Verify Access in a signed-out/private browser window. The dashboard URL must show the Cloudflare Access flow or be denied; it must never return dashboard HTML or JSON. Sign in as the authorized owner and verify `/api/health` returns `{"status":"ok","database":"available"}` and the dashboard opens. The Worker code also checks `ctx.access` and the email, so an incomplete Access configuration remains closed.

7. Edit the public, non-secret configuration with the real URL from step 3:

   ```js
   window.PORTFOLIO_ANALYTICS_CONFIG = {
     collectorUrl: 'https://<actual-collector-url>/v1/events'
   };
   ```

   `https://<actual-collector-url>/v1/events` is a placeholder only. Use Wrangler's real output; do not guess a `workers.dev` subdomain.

8. Commit and push the repository. Before relying on the supplied Pages workflow, in GitHub repository **Settings > Pages**, choose **Source: GitHub Actions**. The workflow copies only `index.html`, `project.html`, `privacy.html`, `assets/`, `css/`, and `js/` into the Pages artifact. It deliberately excludes `cloudflare/`, `docs/`, `package.json`, and local development files, so Worker source and configuration do not become public static files. This repository had no tracked Pages workflow at inspection time; confirm this setting rather than assuming its current source.

   ```powershell
   git add .
   git commit -m "Add Cloudflare portfolio analytics"
   git push origin main
   ```

9. Confirm `https://rntlbt.github.io/` still loads, project links still use `project.html?id=<project-id>`, and a browser visit produces a new event in the private dashboard. In D1, the owner can also inspect the remote database with:

   ```powershell
   npx.cmd wrangler d1 execute rntlbt-portfolio-db --remote --command "SELECT event_name, COUNT(*) AS count FROM analytics_events GROUP BY event_name;"
   ```

10. Monitor the D1 database in Cloudflare Dashboard > D1 > `rntlbt-portfolio-db` > Metrics. Back up before schema changes with a remote export suitable for the installed Wrangler version, for example:

    ```powershell
    npx.cmd wrangler d1 export rntlbt-portfolio-db --remote --output .\backups\rntlbt-portfolio-db.sql
    ```

    Keep backups outside the public repository or in an ignored local directory.

## Free-tier notes

Current Cloudflare documentation lists Workers Free at 100,000 requests/day and 10 ms CPU time per request. D1 Free includes 5 GB storage, 5 million rows read/day, and 100,000 rows written/day. D1 free-limit enforcement means queries fail until the next UTC day once a daily allowance is exhausted. The implementation uses a single event insert plus small indexed session/browser maintenance writes, small response payloads, no external dependencies, and a daily cleanup cron. Cloudflare Access supports protecting a Worker’s `workers.dev` production URL, including all of its routes. Cloudflare One Free supports up to 50 users, sufficient for one owner.

At normal personal-portfolio traffic this is well within free limits. Do not add high-volume event types such as mouse movement or scrolling. If traffic unexpectedly approaches limits, first reduce event volume/retention and inspect indexed queries; do not silently turn off the dashboard's security.

Official references:

- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 pricing and limits](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Cloudflare D1 migrations with Wrangler](https://developers.cloudflare.com/d1/reference/migrations/)
- [GitHub Pages custom workflow deployment](https://docs.github.com/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## What Codex completed versus owner actions

Codex completed the repository inspection, schema migration, two Worker implementations, frontend integration, privacy page, dashboard, local testing configuration, local D1 migration, and this deployment guide. Codex did not touch the remote D1 database, deploy a Worker, configure Cloudflare Access, set the owner secret, change GitHub Pages settings, or push commits because those are account-specific actions requiring the owner’s authorization.
