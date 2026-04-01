# Copilot Instructions

## Project Scope

This repository is a static website for ranking 2026 World Cup groups by toughness using FIFA ranking points.

### Hard Limits

- The site must stay static (no backend server, no database, no runtime API proxy).
- Frontend data loading must come from committed files in this repo (primarily `data/rankings.json`).
- Browser code must not rely on direct FIFA API calls because of CORS/Cloudflare restrictions.
- Keep dependencies minimal and avoid adding build systems unless explicitly requested.

## Data Update Model

Rankings are refreshed by automation, not by the browser:

1. `scripts/fetch-rankings.mjs` fetches/parses ranking data.
2. It writes `data/rankings.json`.
3. GitHub Actions commits the updated JSON back to `main`.
4. GitHub Pages serves the updated static files.

## Deployment

- Hosting target: GitHub Pages from the `main` branch root.
- Main workflow: `.github/workflows/update-rankings.yml`.
- Trigger modes:
  - Scheduled run (cron)
  - Manual run (`workflow_dispatch`)
- On each successful update, the workflow commits `data/rankings.json` with `[skip ci]`.

## Contributor Guidance

When making changes:

- Preserve static-first architecture.
- Prefer robust parsing/fallback logic in `scripts/fetch-rankings.mjs` over introducing services.
- Keep `index.html` resilient to missing teams via alias mapping and graceful UI fallbacks.
- Validate that both local and Actions runs can regenerate `data/rankings.json`.

## What Not To Add Without Approval

- Server-side runtimes (Express, Next.js server, Cloud Functions, etc.)
- Secrets-dependent deployment flows
- Paid APIs or scraping providers
- Complex frontend frameworks for this simple static use case
