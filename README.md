# AI Betting Bot

A production-grade **broadcast-only Telegram group bot** that publishes **analytical betting opinions based on structured sports data**, written in **Greek** with a friendly, group-style tone — powered by OpenAI `gpt-5.4` for screening and expert analysis, `gpt-5.4-mini` for odds event matching, and **The Odds API** for real-time market verification from 40+ European bookmakers.

The bot does not chat with users, answer commands, or behave like an assistant. It acts like a curated feed: shortly before each fixture it posts one well-reasoned tip — or stays silent when nothing passes all quality gates.

---

## Architecture overview

```
src/
├── index.ts                        Entry point — launches bot + scheduler
├── config.ts                       Centralised env-var config
├── types/index.ts                  All TypeScript interfaces
├── utils/
│   ├── logger.ts                   Winston logger + picksLogger (audit log)
│   ├── retry.ts                    Exponential back-off retry
│   ├── date.ts                     Date/time helpers (UTC + Athens timezone)
│   └── checkpoint.ts               Fixtures checkpoint (survives restarts)
├── sports/
│   ├── fixtures.ts                 Fetches tomorrow's scheduled fixtures
│   ├── enrichment.ts               Enriches fixtures with odds + structured context
│   └── providers/
│       ├── thesportsdb-fixtures.ts TheSportsDB fixture fetch (free, no key required)
│       ├── thesportsdb-enrichment.ts Form, H2H, injuries, schedule fatigue
│       └── odds-api.ts             The Odds API — real-time odds, 40+ bookmakers
├── ai-analysis/
│   ├── schema.ts                   Sport-aware JSON Schema (soccer vs basketball)
│   ├── prompts.ts                  System/user prompt builders — sport-aware odds section
│   ├── screener.ts                 Phase 1 — fast screening (medium reasoning effort)
│   ├── expert.ts                   Phase 2 — deep expert analysis (high/xhigh effort)
│   ├── validator.ts                Response validation & hallucination guard
│   └── index.ts                    Pipeline orchestrator + 6-gate publication check
├── odds/
│   └── index.ts                    Gate 5 — market availability & min-odds verification
├── bot/
│   ├── formatter.ts                Telegram HTML message formatter (Greek UI)
│   ├── publisher.ts                Sends approved tips to the Telegram group
│   └── telegram.ts                 Bot setup (broadcast-only), group sender
└── scheduler/
    ├── dedup.ts                    Deduplication — prevents double-posting
    └── index.ts                    Planning cron + per-fixture pre-match jobs
```

---

## How the scheduling works

The bot uses a **two-phase scheduling model**:

**Phase A — Planning job** (default: 2:00 AM UTC nightly via `PLANNING_CRON`):
1. Fetches tomorrow's fixtures from TheSportsDB
2. Checkpoints them to disk (survives a restart)
3. Schedules a **per-fixture analysis job** for each match, timed to fire `HOURS_BEFORE_KICKOFF` hours before kickoff (default: 8 hours)

**Phase B — Per-fixture job** (fires automatically at scheduled time):
1. Live web search via `gpt-5.4` to fetch latest form, injuries, standings
2. TheSportsDB enrichment — structured form, H2H, schedule fatigue
3. The Odds API — real-time odds for all available markets
4. Two-phase AI analysis (screening → expert)
5. Six-gate publication check
6. If all gates pass → post to Telegram, log to picks audit file

On startup the scheduler also **recovers any jobs from today's checkpoint** in case the process was restarted mid-day.

---

## Two-phase AI pipeline

| Phase | Model | Reasoning effort | Purpose |
|-------|-------|------------------|---------|
| 1 — Screening | `gpt-5.4` | `medium` | Score all fixtures 0–10, select best 3–5 candidates |
| 2 — Expert analysis | `gpt-5.4` | `high` / `xhigh` | Full professional betting analysis on shortlisted matches |
| Odds event matching | `gpt-5.4-mini` | `low` | Match TheSportsDB team names → The Odds API canonical names |

Deep reasoning is used only where it adds value. `gpt-5.4-mini` handles the event-matching task where the only job is comparing two lists of names — cheap and reliable.

**OpenAI integration notes:**
- Both analysis phases use the **`developer` role** (OpenAI's recommended instruction layer for newer models)
- All responses use **strict JSON Schema** structured outputs via the Responses API
- The expert schema is **sport-aware** — basketball schema explicitly forbids Draw, BTTS, 1X, X2, G/G; soccer schema includes them
- The model is **never used to discover fixtures** — all live facts are fetched from sports providers first, the model only reasons over them

---

## Real-time odds (The Odds API)

Real-time odds are fetched from [The Odds API](https://the-odds-api.com) using **40+ European bookmakers** (Pinnacle, Bet365, Unibet, etc.).

### How event matching works

TheSportsDB and The Odds API use different team name formats (e.g. "Lyon-Villeurbanne" vs "ASVEL Lyon Villeurbanne"). The bot resolves this in two steps, **both free of odds quota cost**:

1. **FREE `/events` endpoint** — retrieves all upcoming events for the sport key; no quota used
2. **`gpt-5.4-mini` (LLM matching)** — given the fixture's home/away team names and the list of API events, returns the correct index; reliable across any naming variant

Once the canonical event ID is known, a **single targeted call** fetches all markets in one request: `h2h,totals,btts` for soccer; `h2h,totals` for basketball (BTTS excluded — it doesn't exist in basketball).

### Sport-aware market fetching

| Market | Soccer | Basketball |
|--------|--------|------------|
| Match Winner (1X2 / Moneyline) | ✅ Home / Draw / Away | ✅ Home / Away only (no draw) |
| Over/Under | ✅ ~2.5 goals (actual line from API) | ✅ ~215.5 points (actual line from API) |
| Both Teams to Score | ✅ | ❌ not fetched |
| Asian Handicap | available in prompt guidance | ❌ not in basketball prompt |

The actual totals line (e.g. 215.5) is extracted from the most common offering across bookmakers and surfaced in the AI prompt with the correct label.

---

## Quick start

### 1. Clone & install

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your keys
```

Required keys:
- `TELEGRAM_BOT_TOKEN` — from [@BotFather](https://t.me/BotFather)
- `TELEGRAM_GROUP_CHAT_ID` — negative number for groups, e.g. `-100123456789`
- `OPENAI_API_KEY` — from [platform.openai.com](https://platform.openai.com)
- `THE_ODDS_API_KEY` — from [the-odds-api.com](https://the-odds-api.com) (Gate 5 real-time verification)

TheSportsDB requires **no API key** for the free tier used here.

### 3. Run

```bash
# Development (ts-node-dev with auto-reload)
npm run dev

# Production
npm run build
npm start
```

The planning job runs at `PLANNING_CRON` (default 2:00 AM UTC). To trigger it immediately for testing, call `runPlanningJob(dateOverride)` from `src/scheduler/index.ts` with a date string.

---

## Telegram behavior model

The bot is **broadcast-only** — no command handlers, no replies.

| Behavior | Detail |
|----------|--------|
| Commands | None registered |
| Replies | Never replies to users |
| Posting trigger | `PLANNING_CRON` schedules per-fixture jobs; each fires `HOURS_BEFORE_KICKOFF` before kickoff |
| When no picks pass gates | Silent — no message sent |
| Message rate | 1.5 s delay between posts (Telegram rate limit safety) |

---

## Language and tone

All user-facing output is in **Greek**.

| Rule | Detail |
|------|--------|
| Language | Greek (`shortReasoning`, headers, labels) |
| Tone | Friendly, conversational, παρέα-style — like a knowledgeable sports friend posting in a group |
| Avoid | Robotic phrasing, formal disclaimers, generic AI-assistant language |
| Internal fields | `keyFacts` and `riskFactors` in English (not shown to users) |

The Greek phrasing is controlled via `EXPERT_DEVELOPER_PROMPT` in `src/ai-analysis/prompts.ts`. Tone examples and hard rules are embedded in the developer-role instructions.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | — | **Required** |
| `TELEGRAM_GROUP_CHAT_ID` | — | **Required** |
| `OPENAI_API_KEY` | — | **Required** |
| `THE_ODDS_API_KEY` | — | **Required** — Gate 5 real-time market verification |
| `OPENAI_MODEL` | `gpt-5.4` | Model for screening + expert analysis |
| `OPENAI_SCREENING_EFFORT` | `medium` | Reasoning effort for screening phase |
| `OPENAI_EXPERT_EFFORT` | `high` | Reasoning effort for expert analysis |
| `OPENAI_TIMEOUT_MS` | `90000` | Per-call timeout in ms — fixture skipped on expiry |
| `PLANNING_CRON` | `0 2 * * *` | Cron for nightly planning job (2:00 AM UTC) |
| `TIMEZONE` | `UTC` | Cron timezone |
| `HOURS_BEFORE_KICKOFF` | `8` | How many hours before kickoff to post the tip |
| `MIN_INTEREST_SCORE` | `5` | Min screening score to trigger deep analysis |
| `MIN_CONFIDENCE_TO_PUBLISH` | `6` | Min AI confidence to publish a tip |
| `MIN_ACCEPTABLE_ODDS` | `1.50` | Tips with lower odds are blocked (Gate 5) |
| `MAX_TIPS_PER_DAY` | `5` | Cap on daily tips published |
| `MAX_CANDIDATES_FROM_SCREENING` | `10` | Max fixtures forwarded to expert analysis |
| `FORCE_ANALYSIS` | `false` | **Dev only** — bypasses screening, Gate 5, and dedup |
| `DB_PATH` | `./data/posted.db` | Deduplication store path |
| `LOG_LEVEL` | `info` | Winston log level |

---

## Logs

| File | Contents |
|------|----------|
| `logs/combined.log` | All log entries (info and above) as JSON |
| `logs/error.log` | Error-level entries only |
| `logs/picks.log` | Append-only audit log of every published pick — fixture, competition, pick, market, confidence, date |

`logs/picks.log` is the primary source for ROI tracking and prompt tuning. Each line is newline-delimited JSON.

---

## Sports data provider

Fixtures and enrichment data come from **TheSportsDB** ([thesportsdb.com](https://www.thesportsdb.com)) — **free tier, no API key required**.

Supported leagues (configured in `src/sports/providers/thesportsdb-fixtures.ts`):

| Competition | Type | League ID |
|-------------|------|-----------|
| Premier League | Football | 4328 |
| Bundesliga | Football | 4331 |
| Serie A | Football | 4332 |
| La Liga | Football | 4335 |
| Ligue 1 | Football | 4334 |
| UEFA Champions League | Football | 4480 |
| UEFA Europa League | Football | 4481 |
| NBA | Basketball | 4387 |
| EuroLeague | Basketball | 4546 |

To add or remove leagues, edit the `TARGET_LEAGUES` array in `thesportsdb-fixtures.ts`.

---

## Quality controls (Six-gate publication rule)

A tip is published only when **all six** conditions pass:

| Gate | Condition |
|------|-----------|
| 1 | Fixture status is `scheduled` |
| 2 | Data quality is `medium` or `high` — stale form (>45 days) or missing form for both teams is a **hard reject** |
| 3 | Model returns `isPickRecommended: true` |
| 4 | Confidence ≥ `MIN_CONFIDENCE_TO_PUBLISH` (default 6/10) |
| 5 | The Odds API confirms the recommended market exists at odds ≥ `MIN_ACCEPTABLE_ODDS` (default 1.50) |
| 6 | Fixture has not already been posted today (dedup store) |

Additional controls:
- **Hallucination guard** — validator checks team names against fixture source of truth before publishing
- **Analysis caps** — `MAX_CANDIDATES_FROM_SCREENING` limits deep-analysis spend; `MAX_TIPS_PER_DAY` caps total daily output
- **Per-call timeout** — OpenAI calls abort after `OPENAI_TIMEOUT_MS`; timed-out fixtures are skipped, not published
- **Checkpoint recovery** — if the process restarts, today's fixtures are reloaded and their jobs are rescheduled

---

## Prompt engineering summary

### Screening prompt (Phase 1)
- Scores fixtures 0–10 for betting interest — considers rivalry, data availability, competitive balance, market inefficiency
- Conservative threshold: only flags matches with genuine data and edge
- Returns `shouldAnalyze: true` only for the best 3–5 fixtures

### Expert system prompt (Phase 2)
- Elite professional betting analyst persona
- Hard rules: no invented facts, separate confirmed from inferred, one best pick per match
- Self-rejection: returns `isPickRecommended: false` when data is insufficient
- Calibrated confidence: 7+ = strong conviction, 5–6 = moderate, <5 = no pick
- Market selection rules: avoid odds below 1.50; for heavy favorites look at totals/BTTS/handicap
- **Sport-aware**: basketball prompt explicitly bans Draw, BTTS, X2, 1X, G/G, Ισοπαλία

### Sport-aware JSON schema
The expert schema is built at runtime via `buildExpertAnalysisSchema(isSoccer)`:
- **Soccer schema**: `finalPick` and `bestBettingMarket` include Draw, BTTS, 1X, X2, G/G
- **Basketball schema**: these fields explicitly forbid those markets and require basketball-appropriate notation

---

## OpenAI implementation guardrails

| The model IS | The model is NOT |
|---|---|
| analyst reasoning over facts | live sports database |
| market value evaluator | odds feed |
| risk assessor | injury/form source |
| pick recommender | fixture discovery engine |
| event name matcher (`gpt-5.4-mini`) | canonical ID oracle |

All facts (fixtures, form, injuries, schedule, odds) are fetched from external providers **before** the model sees them. The model reasons over data — it never invents it.

---

## Disclaimer

This bot produces analytical opinions for informational purposes only. It does not constitute financial or gambling advice. Always bet responsibly and within your means.
├── config.ts                 Centralised env-var config
