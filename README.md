# Serendipity

A private, chat-first web app that suggests what to watch on **US Netflix** for a two-person household.
Describe what you're in the mood for; it returns 10 titles that are streaming on Netflix right now,
each with a short note on why it was picked. It learns from your Netflix viewing history, your
thumbs up / meh / thumbs down ratings, and NYT Critic's Picks.

## How it works

- **Viewing history:** upload Netflix's viewing-activity CSV. Episodes are grouped into shows and each
  show or movie is matched to a TMDB title. Anything ambiguous lands in a short review list.
- **Chat:** Claude turns the request (plus earlier messages) into search criteria. The app gathers
  candidates from TMDB that are on US Netflix (discover with the Netflix provider, recommendations
  from titles you like, cast/crew filmographies, NYT Critic's Picks), drops anything you've watched
  or thumbed down, and Claude picks the best 10 with a reason for each. Availability is re-checked
  (cached for a day) before results are shown.
- **Watching together** (default) blends both profiles and avoids titles either person disliked.
  "Just me" uses only the current profile's ratings.
- **NYT:** a daily cron pulls new movie and TV reviews from the NYT Article Search API, reads the
  Critic's Pick flag, and slowly backfills older Critic's Picks (the free key allows ~500 calls/day).

Stack: Next.js (App Router) · Drizzle ORM · libSQL/Turso (SQLite file locally) · Anthropic Claude API ·
TMDB API · NYT Article Search API. Installable on iPhone via Safari → Share → Add to Home Screen.

## Environment variables

| Name | What |
| --- | --- |
| `TMDB_API_KEY` | TMDB "API Read Access Token" (or the short v3 key) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `NYT_API_KEY` | NYT developer key (Article Search enabled) |
| `DATABASE_URL` | `libsql://…turso.io` in production, `file:local.db` locally (`TURSO_DATABASE_URL` also works) |
| `DATABASE_AUTH_TOKEN` | Turso token, production only (`TURSO_AUTH_TOKEN` also works) |
| `APP_PASSCODE` | The household passcode for signing in |
| `AUTH_SECRET` | Any long random string |
| `CRON_SECRET` | Any long random string; Vercel sends it to the daily NYT sync |
| `PROFILE_NAMES` | Optional, e.g. `Jeff,Sam` (names can also be changed in the app) |
| `CLAUDE_MODEL` | Optional, defaults to `claude-opus-5-5` |

## Local development

```bash
npm install
cp .env.example .env.local   # fill in keys
npm run db:migrate
npm run dev
```

In a sandbox that needs an HTTPS proxy, run Node with `NODE_USE_ENV_PROXY=1`.

## Deploy (Vercel + Turso, free tiers)

1. In Vercel, Add New → Project → import this repo.
2. In the project's Storage tab, add a Turso database (Marketplace). It sets `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` for you.
   (Or create one at turso.tech and set `DATABASE_URL` / `DATABASE_AUTH_TOKEN` yourself.)
3. Add the other environment variables above, then redeploy. The build runs the database
   migrations, and `vercel.json` schedules the daily NYT sync.

## Tests

```bash
npm test
```

This product uses the TMDB API but is not endorsed or certified by TMDB. Review data from The New York Times.
