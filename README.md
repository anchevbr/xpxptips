# AI Betting Bot

AI Betting Bot is a broadcast-only Telegram bot for football and basketball picks inside the configured group chat. It does not act like a conversational assistant in the group. Its job is to run a structured betting-analysis pipeline, publish only the picks that pass hard gates, and then follow those picks with live halftime and full-time updates plus pinned weekly and monthly reports.

Outside the group flow, the bot also supports a minimal private-operator path: `/start` and `/logs` in a private chat only manage runtime log subscriptions for the operator.

This repository is built around three ideas:

- sports data should come from providers first, not from the model,
- AI should be used for reasoning and explanation, not for inventing facts,
- operational state should survive restarts through checkpoints and persistent logs.

## Current feature set

- Pre-match tip generation for football and basketball fixtures.
- Timezone-aware daily planning for the current calendar day in `TIMEZONE` (default `0 6 * * *` in `Europe/Athens`).
- Direct expert analysis for every fetched fixture, followed by hard publication gates.
- OpenAI live-context fetch with web search, activity logging, and retry/backoff for transient failures.
- Real bookmaker market validation before a tip can be published.
- Broadcast-only Telegram posting with HTML formatting and disabled link previews.
- Reply-chained halftime updates for each published fixture.
- Reply-chained full-time updates for each published fixture.
- Weekly report posting every Monday.
- Monthly report posting on the first Monday of each month.
- Pinning for weekly/monthly reports.
- Private Telegram runtime log forwarding for the operator.
- Long-lived historical picks log with outcome resolution for reports and recovery.
- Checkpoint-based crash recovery for fixture discovery and expert analysis.
- Manual test entry scripts under `src/test/` for end-to-end and feature-specific validation.

## High-level architecture

```text
src/
├── index.ts
├── config.ts
├── ai-analysis/
│   ├── index.ts
│   ├── expert.ts
│   ├── prompts.ts
│   ├── schema.ts
│   └── validator.ts
├── bot/
│   ├── telegram.ts
│   ├── publisher.ts
│   └── formatter.ts
├── fulltime/
│   ├── index.ts
│   ├── watcher.ts
│   ├── narrator.ts
│   └── stats-fetcher.ts
├── halftime/
│   ├── index.ts
│   ├── watcher.ts
│   ├── narrator.ts
│   └── stats-fetcher.ts
├── odds/
│   └── index.ts
├── reports/
│   ├── index.ts
│   ├── picks-store.ts
│   ├── result-fetcher.ts
│   ├── result-resolver.ts
│   ├── report-generator.ts
│   └── report-formatter.ts
├── scheduler/
│   ├── index.ts
│   └── dedup.ts
├── sports/
│   ├── fixtures.ts
│   ├── enrichment.ts
│   └── providers/
│       ├── api-sports-fixtures.ts
│       ├── api-sports-enrichment.ts
│       ├── api-sports-live.ts
│       └── odds-api.ts
├── test/
│   ├── test-runner.ts
│   ├── test-report.ts
│   ├── test-halftime.ts
│   ├── test-fulltime.ts
│   └── crash-test.ts
├── types/
│   └── index.ts
└── utils/
    ├── checkpoint.ts
    ├── date.ts
    ├── logger.ts
    └── retry.ts
```

## End-to-end runtime flow

### 1. Process startup

`src/index.ts` loads configuration, launches the Telegram bot in long-polling mode, and starts the scheduler.

The Telegram client is intentionally minimal in the group chat:

- no group commands are registered,
- group messages are not answered,
- normal send operations go to the configured group chat,
- private `/start` and `/logs` commands exist only for operator log subscription and status,
- reports can be pinned through `sendAndPinInGroup()`.

### 2. Planning job

The planning job runs on `PLANNING_CRON` in `TIMEZONE`.

The current default config is `0 6 * * *` in `Europe/Athens`.

Its job is to:

1. determine the target date in `TIMEZONE`,
2. fetch fixtures from API-Sports,
3. write those fixtures to checkpoint storage,
4. schedule a per-fixture analysis job for each fixture at `kickoff - ANALYSIS_HOURS_BEFORE_KICKOFF`,
5. send the tip immediately when that analysis finishes and passes all gates.

By default, the nightly run targets the current calendar day in `TIMEZONE`, not UTC tomorrow.

If the process restarts, the scheduler attempts to recover pending analysis jobs for today and tomorrow in `TIMEZONE` from checkpoint data.

### 3. Fixture discovery

Fixture discovery uses API-Sports date-based schedule endpoints with header authentication. The code sends both the target `date` and the configured `TIMEZONE` so the provider returns the slate for the same calendar day the scheduler is targeting, then filters locally by tracked competition and team metadata.

Supported competitions in the current code:

| Competition | Sport | API-Sports league ID |
| --- | --- | --- |
| Premier League | Football | 39 |
| La Liga | Football | 140 |
| Serie A | Football | 135 |
| Bundesliga | Football | 78 |
| Ligue 1 | Football | 61 |
| UEFA Champions League | Football | 2 |
| UEFA Europa League | Football | 3 |
| NBA | Basketball | 12 |
| EuroLeague | Basketball | 120 |

### 4. Analysis flow

There is no screening phase anymore. Every fetched fixture is enriched and sent to the expert model.

Pipeline behavior:

- every fixture is enriched with provider data before expert reasoning,
- expert analysis runs for every fetched fixture unless an analysis checkpoint already exists,
- low-quality or unsupported fixtures are filtered later by the publication gates rather than by a prefilter,
- historical pick performance is not fed back into this stage automatically,
- `FORCE_ANALYSIS=true` can bypass the scheduled-status and odds-market gates for testing.

### 5. Enrichment and odds loading

For each fixture, the pipeline enriches the match with:

- structured API-Sports context,
- provider-supported H2H and injuries where available,
- available real bookmaker odds from The Odds API.

The enrichment layer also computes an `availableOdds` block that includes:

- home/draw/away prices,
- totals prices,
- BTTS prices for football,
- the most commonly offered totals line across bookmakers,
- bookmaker count.

### 6. Expert analysis phase

The second AI pass produces the actual betting recommendation.

Operationally, expert analysis is split into two OpenAI phases:

- a live-context web-search pass that gathers current form, injuries, tactical and motivation context,
- the final structured JSON analysis pass that decides whether a pick is publishable.

The expert phase returns:

- `finalPick`,
- `bestBettingMarket`,
- `confidence`,
- `shortReasoning`,
- structured risk and quality information,
- a flag indicating whether the model recommends publishing a pick at all.

The pipeline never publishes straight from expert output. It still has to pass the publication gate.

### 7. Publication gate

A pick can only be published when all of these pass:

1. the fixture status is acceptable,
2. data quality is not low,
3. the model explicitly recommends a pick,
4. confidence is at least `MIN_CONFIDENCE_TO_PUBLISH`,
5. the real market exists and its odds are at least `MIN_ACCEPTABLE_ODDS`,
6. the fixture has not already been posted that day.

This is the main protection against low-value favorites, missing markets, stale fixtures, and duplicate sends.

### 8. Telegram publication

When a fixture passes all gates:

- the message is formatted in Greek,
- available odds are fetched and appended when possible,
- the tip is sent to the configured Telegram group as a standalone message,
- the dedup store is updated,
- the pick is persisted to `data/picks-log.json` together with kickoff time,
- halftime and full-time watchers are scheduled immediately.

Pre-match tips are not pinned. Weekly and monthly reports are pinned.

Reply behavior is intentional:

- pre-match tip: standalone group post,
- halftime update: replies to the original pre-match tip,
- full-time update: replies to the halftime update when one exists, otherwise to the original pre-match tip,
- weekly and monthly reports: standalone pinned posts, not replies.

### 9. Halftime updates

Each published pick gets its own independent halftime watcher.

Current behavior:

- start time: roughly `kickoff + 40 minutes`,
- polling interval: every 10 minutes,
- max attempts: 6,
- trigger condition: the live-data provider status becomes `HT`, `half time`, or `halftime`.

When halftime is detected, the bot:

1. fetches live score,
2. fetches event stats,
3. fetches lineup information when available,
4. calls GPT with `web_search_preview`,
5. generates a Greek halftime commentary,
6. sends the halftime update to Telegram,
7. records `halfTimeNotifiedAt` in `data/picks-log.json`.

The halftime prompt is opinionated:

- it is anchored to the exact match date,
- it asks for player-specific performance references when possible,
- it classifies the tip as on track, at risk, or already lost,
- it only mentions withdrawal when the prompt judges the pick as effectively dead,
- markdown links are stripped from model output before posting.

### 10. Full-time updates

Each published pick also gets its own independent full-time watcher.

Current behavior:

- start time: roughly `kickoff + 85 minutes`,
- polling interval: every 10 minutes,
- max attempts: 12,
- trigger condition: the live-data provider status becomes `FT`, `AET`, `AOT`, `Pen`, or `full time`.

When full-time is detected, the bot:

1. fetches final score,
2. determines the betting outcome from `bestBettingMarket` plus the final score,
3. fetches event stats and lineups,
4. calls GPT with a full-time prompt,
5. posts a Greek win/loss/push breakdown,
6. updates `outcome`, `actualScore`, `resolvedAt`, and `fullTimeNotifiedAt` in `data/picks-log.json`.

The full-time narrator changes tone based on the actual result:

- win: celebratory explanation of what went right,
- loss: short objective post-mortem and why the pick failed,
- push: neutral explanation of how the line landed exactly.

### 11. Reports

The report system works off `data/picks-log.json`.

Weekly report:

- runs every Monday at 10:00 Athens time,
- covers the previous 7 days,
- resolves any still-pending outcomes before generating the report,
- posts the message pinned.

Monthly report:

- runs only on the first Monday of the month,
- covers the previous calendar month excluding the final 7 days,
- avoids duplicating the same window already covered by the weekly report,
- also posts pinned.

### 12. Historical record and learning

The bot keeps a long-lived historical record of published picks and resolved outcomes, but that history is not currently used as an automatic self-learning loop.

What the bot does use history for:

- weekly and monthly reporting,
- full-time result resolution and post-match bookkeeping,
- rebuilding halftime/full-time watchers after restart,
- operational audit of what was posted, when, and with what confidence.

What the bot does not do today:

- automatic threshold recalibration from past win/loss rate,
- automatic prompt rewriting from historical performance,
- automatic league or market weighting based on past outcomes,
- model fine-tuning or retraining from `data/picks-log.json`.

Any improvement in pick quality is therefore manual at the moment: code changes, prompt updates, config tuning, or provider improvements.

## Providers and external dependencies

### OpenAI

Current model usage in the codebase:

| Use case | Model |
| --- | --- |
| Expert analysis | `gpt-5.4` |
| Halftime commentary | `gpt-5.4` |
| Full-time commentary | `gpt-5.4` |
| Odds event-name matching | `gpt-5.4` |
| Report narratives | `gpt-5.4` |

The model is used for reasoning and explanation. Fixtures, live statuses, stats, and odds come from provider APIs.

Additional runtime behavior:

- live-context and report web-search calls are executed through the Responses API streaming path,
- web-search activity and reasoning summaries are logged while the call is in flight,
- transient OpenAI failures such as rate limits and timeouts are retried with backoff,
- `openai-usage` lines are written for successful calls so token usage can be audited from logs.

### API-Sports

API-Sports is the only sports-data provider used by the app for:

- fixture discovery,
- pre-match structured enrichment,

- football halftime/full-time live status,
- football full-time result resolution for reports,
- football embedded fixture statistics and lineups,
- basketball halftime/full-time live status,
- basketball full-time result resolution for reports,
- basketball quarter-by-quarter score breakdown used as lightweight live stats.

Implemented provider split:

- football: `API-FOOTBALL` (`https://v3.football.api-sports.io`)
- basketball: `API-BASKETBALL` (`https://v1.basketball.api-sports.io`)

The code stores a provider-specific `liveDataFixtureId` in `data/picks-log.json` when a tip is published so the watchers and the report resolver can reuse the same mapping.

See `docs/api-sports.md` for the exact endpoints, league IDs, status semantics, and free-plan caveats used by the implementation.

### Private operator logs

The bot can also forward runtime logs to a private Telegram chat for operator monitoring.

- Set `TELEGRAM_LOG_CHAT_ID` to a fixed personal chat id, or
- send `/start` or `/logs on` to the bot in a private chat to subscribe dynamically,
- send `/logs status` to check whether the current private chat is subscribed,
- send `/logs off` to stop personal log delivery.

The forwarder batches messages, filters out noisy low-signal lines, and is intended for operational visibility without opening the VPS.

### The Odds API

The Odds API is used for Gate 5 and odds display.

Current behavior:

- resolve canonical event identity first through the free `/events` endpoint,
- use `gpt-5.4` to match provider team-name variants,
- fetch the selected event's odds afterward,
- use only the `eu` region from The Odds API,
- average odds across bookmakers for validation and display,
- for totals markets, average only bookmakers offering the same totals line as the chosen pick,
- reject picks whose market is missing or priced below the configured threshold.

Football currently fetches:

- `h2h`,
- `totals`,
- `btts`.

Basketball currently fetches:

- `h2h`,
- `totals`.

## Betting market model

The code currently operates on these internal market tokens:

| Token | Meaning |
| --- | --- |
| `h2h/home` | Home team to win |
| `h2h/draw` | Draw |
| `h2h/away` | Away team to win |
| `totals/over` | Over the extracted totals line |
| `totals/under` | Under the extracted totals line |
| `btts/yes` | Both teams to score |
| `btts/no` | Both teams not to score |

Outcome resolution for reports and full-time notifications is based on those tokens plus the final score.

## Telegram output model

The Telegram layer is intentionally simple and deterministic:

- HTML parse mode is enabled.
- Link previews are disabled.
- The group chat path runs in broadcast-only mode.
- Group messages are not answered.
- Private `/start` and `/logs` commands are handled only for operator log subscriptions.
- Reports use `sendAndPinInGroup()`.
- Pre-match tips are standalone messages sent with `sendToGroup()`.
- Halftime updates reply to the original tip message.
- Full-time updates reply to the halftime message when available, otherwise to the original tip.
- Reports are pinned but do not reply to another message.

The pre-match formatter includes:

- competition label,
- kickoff time in Athens timezone,
- short reasoning,
- final pick,
- odds when they can be resolved.

## Persistence model

### Checkpoints

Checkpoint storage lives under `data/checkpoints/{date}/`.

Current layout:

```text
data/checkpoints/{date}/
├── fixtures.json
└── analysis/
    └── {fixtureId}.json
```

What is checkpointed:

- fetched fixtures for the day,
- per-fixture expert analysis.

This allows the process to resume without repeating expensive steps after a restart.

### Picks log

`data/picks-log.json` is the long-lived record of published picks.

Each record stores:

- fixture identity,
- date and teams,
- kickoff time,
- posted pick and market token,
- confidence,
- short pre-match reasoning,
- Telegram message ids for tip / halftime / full-time posts,
- live-data provider binding for later polling and result resolution,
- resolved outcome,
- actual score,
- `halfTimeNotifiedAt`,
- `fullTimeNotifiedAt`.

This file is the base for weekly and monthly reporting.

### Telegram log subscriber store

`data/telegram-log-subscribers.json` stores private chat ids that subscribed to runtime log delivery.

Important operational detail:

- this file is separate from picks and checkpoints,
- a `--reset-data` deploy clears checkpoints, picks log, and dedup state,
- it does not delete Telegram log subscriptions.

### Dedup store

The dedup layer persists a JSON file keyed by date and fixture ID.

Important implementation detail:

- `DB_PATH` defaults to `./data/posted.db` in config,
- the dedup layer normalizes that to a JSON file by replacing `.db` with `.json`,
- in practice the default runtime store behaves like `./data/posted.json`.

## Configuration

### Required environment variables

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_GROUP_CHAT_ID`
- `OPENAI_API_KEY`
- `THE_ODDS_API_KEY`
- `APISPORTS_API_KEY`

### Optional environment variables and defaults

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_MODEL` | `gpt-5.4` | Main model for expert analysis and odds event matching |
| `OPENAI_LIVE_CONTEXT_MODEL` | `OPENAI_MODEL` | Optional model override for the live web-search context fetch |
| `OPENAI_COMMENTARY_MODEL` | `gpt-5.4` | Model for halftime and full-time commentary |
| `OPENAI_REPORT_MODEL` | `gpt-5.4` | Model for weekly and monthly report narratives |
| `OPENAI_COMMENTARY_EFFORT` | `high` | Reasoning effort for halftime and full-time commentary |
| `OPENAI_REPORT_EFFORT` | `high` | Reasoning effort for report narratives |
| `OPENAI_LIVE_CONTEXT_EFFORT` | `medium` | Reasoning effort for the live web-search context fetch |
| `OPENAI_EXPERT_EFFORT` | `high` | Reasoning effort for the final expert analysis |
| `OPENAI_TIMEOUT_MS` | `90000` | Timeout per OpenAI call |
| `TELEGRAM_LOG_CHAT_ID` | `""` | Optional fixed private Telegram chat id for runtime logs |
| `TELEGRAM_LOG_LEVEL` | `info` | Minimum severity forwarded to private Telegram log delivery |
| `TELEGRAM_LOG_BATCH_MS` | `15000` | Batch interval in milliseconds for private Telegram log delivery |
| `APISPORTS_API_KEY` | `""` | API-FOOTBALL and API-BASKETBALL key used for discovery, enrichment, live polling, and result resolution |
| `APISPORTS_TIMEOUT_MS` | `10000` | Timeout per API-Sports request; set to `0` to disable |
| `PLANNING_CRON` | `0 6 * * *` | Nightly planning cron |
| `TIMEZONE` | `Europe/Athens` | Scheduler timezone |
| `ANALYSIS_HOURS_BEFORE_KICKOFF` | `4` | Lead time for the heavy expert-analysis step; approved picks are sent immediately after analysis |
| `MIN_CONFIDENCE_TO_PUBLISH` | `6` | Minimum expert confidence |
| `MAX_TIPS_PER_DAY` | `5` | Daily publication cap |
| `MIN_ACCEPTABLE_ODDS` | `1.50` | Gate 5 minimum odds |
| `FORCE_ANALYSIS` | `false` | Dev-only bypass for scheduled-status checks, odds gate, and dedup |
| `DB_PATH` | `./data/posted.db` | Dedup store base path |
| `LOG_LEVEL` | `info` | Winston log level |

## Installation and local usage

### Install dependencies

```bash
npm install
```

### Configure environment

```bash
cp .env.example .env
```

Fill in your keys before starting the bot.

### Configure VPS deploy

```bash
cp .deploy.env.example .deploy.env
```

Fill in the VPS host, app path, PM2 app name, and optionally `DEPLOY_SSH_PASSWORD` for password-based SSH. By default the deploy script uploads your local `.env` to the VPS on every deploy.

### Development mode

```bash
npm run dev
```

### Production build

```bash
npm run build
npm start
```

## NPM scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Run the app in development mode with reload |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm start` | Run the compiled app |
| `npm run typecheck` | Run TypeScript typecheck without emit |
| `npm run deploy:vps` | Build locally, upload the app and local `.env` to the VPS, back up the current app, install runtime deps, restart PM2, and run a smoke check |
| `npm run deploy:vps:reset-data` | Same deploy flow, but also clears checkpoints, picks log, and dedup data for the VPS app |
| `npm run test-runner` | Execute the full pipeline for a target date |
| `npm run test-runner-compiled` | Run the compiled test runner from `dist/test/test-runner.js` |
| `npm run test-report` | Seed picks, assign outcomes, and send a pinned test report |
| `npm run test-halftime` | Send 3 halftime test scenarios |
| `npm run test-fulltime` | Send 3 full-time test scenarios |
| `npm run test-crash` | Run the two-phase crash recovery test |

## VPS deploy flow

Standard deploy:

```bash
npm run deploy:vps
```

Deploy and clear the app's runtime data on the VPS:

```bash
npm run deploy:vps:reset-data
```

Useful direct flags:

```bash
./scripts/deploy-vps.sh --dry-run
./scripts/deploy-vps.sh --skip-build
./scripts/deploy-vps.sh --skip-smoke-check
./scripts/deploy-vps.sh --reset-data
```

What the deploy script does:

1. runs local `typecheck` and `build` unless skipped,
2. creates a clean tarball from the current workspace,
3. uploads it to the VPS,
4. backs up the remote app directory,
5. replaces code in place, installs the uploaded local `.env` on the VPS, and preserves `data/` and `logs/`,
6. runs `npm ci --omit=dev` on the VPS,
7. restarts the configured PM2 app,
8. runs a lightweight API-Sports smoke check unless skipped.

`--reset-data` additionally removes:

- `data/checkpoints/`,
- `data/picks-log.json`,
- `data/posted.json`.

It does not remove `data/telegram-log-subscribers.json`.

## Manual test scripts

All manual test entry points now live under `src/test/`.

### 1. Full pipeline test

```bash
npm run test-runner 2026-04-16
```

This:

1. fetches fixtures,
2. runs expert analysis for every fetched fixture,
3. applies the publication gate,
4. posts any qualifying tips to Telegram.

This is a real integration path, not a mocked dry run.

### 2. Compiled test runner

```bash
npm run build
npm run test-runner-compiled 2026-04-16
```

Useful when validating the exact compiled output path and runtime behavior from `dist/`.

### 3. Report test

```bash
npm run test-report 2026-04-16
```

This test:

- seeds picks from checkpoints,
- assigns random outcomes,
- generates the AI report narrative,
- posts the report pinned to Telegram.

### 4. Halftime test

```bash
npm run test-halftime 2026-04-16 football
npm run test-halftime 2026-04-16 basketball
```

This sends three halftime scenarios for a checkpoint-backed pick.

### 5. Full-time test

```bash
npm run test-fulltime 2026-04-16 football
npm run test-fulltime 2026-04-16 basketball
```

This sends three full-time scenarios and verifies win/loss/push commentary.

### 6. Crash recovery test

```bash
TEST_DATE=2026-04-16 npm run test-crash
TEST_DATE=2026-04-16 npm run test-crash
```

Behavior:

- first run fetches fixtures, saves checkpoint state, and exits intentionally,
- second run detects checkpoint presence and continues from disk as a recovery simulation.

## Data and logs

### Data files

| Path | Purpose |
| --- | --- |
| `data/checkpoints/` | Resume state for fixtures and expert analysis |
| `data/picks-log.json` | Published picks plus resolved live/report metadata |
| `data/posted.json` | Dedup store in normal usage |
| `data/telegram-log-subscribers.json` | Private operator chat subscriptions for runtime log forwarding |

### Log files

| Path | Purpose |
| --- | --- |
| `logs/combined.log` | Main structured runtime log |
| `logs/error.log` | Error-only log |

Every successful OpenAI response also writes an `openai-usage` line into the normal application logs with the exact API-reported `input_tokens`, `output_tokens`, and `total_tokens` for that call.

## Operational notes

- The bot must have permission to send messages to the configured group.
- The bot must have permission to pin messages if weekly/monthly reports should pin successfully.
- Halftime and full-time watchers are scheduled with per-fixture `setTimeout`, not cron.
- Post-publication live updates are only scheduled for fixtures that were actually published.
- Restart recovery rebuilds pending halftime and full-time watcher timers for published picks that are still inside their polling windows.
- Historical results are persisted for reporting and recovery, not for automatic self-learning.

## Current limitations

These are important to understand in production:

- The bot does not currently self-calibrate from historical performance; reports explain past results but do not change future thresholds or prompts automatically.
- Halftime and full-time notifications use polling windows, not event subscriptions, so updates are near-real-time rather than exact-to-the-minute.
- Commentary quality depends on provider stats plus web-search availability for that specific match.
- If The Odds API cannot resolve a matching event or market, Gate 5 will block the pick even if the model likes it.

## Operator FAQ

### How do I check quickly that production is healthy?

Use the basic three checks first:

- PM2 status for the `ai-betting-bot` process,
- recent runtime logs from `logs/combined.log` or `pm2 logs`,
- private Telegram log forwarding via `/start`, `/logs on`, or `TELEGRAM_LOG_CHAT_ID`.

If those three look normal, the bot is usually healthy enough for daily operation.

### How do I redeploy safely from local?

Use:

```bash
npm run deploy:vps
```

That uploads the current code and your local `.env`, backs up the remote app, restarts PM2, and runs the API-Sports smoke check.

### When should I use reset-data deploy?

Use:

```bash
npm run deploy:vps:reset-data
```

when you want to clear stale checkpoints, picks history for the app runtime, and dedup state before a fresh production run.

It removes:

- `data/checkpoints/`,
- `data/picks-log.json`,
- `data/posted.json`.

It does not remove `data/telegram-log-subscribers.json`.

### Why did a restart not bring back today's jobs?

Restart recovery can only rebuild timers from persisted state.

That means:

- pre-match planning jobs recover only if the relevant date already has checkpointed fixtures,
- halftime and full-time watchers recover only for published picks that still have usable `kickoffAt` and are still inside the recovery window.

If there is no saved checkpoint or the recovery window has already passed, there is nothing to restore.

### How do Telegram posts thread together?

The posting model is fixed:

- pre-match tip: standalone group message,
- halftime update: reply to the original tip,
- full-time update: reply to halftime if available, otherwise to the original tip,
- weekly/monthly report: standalone pinned message.

### Does the bot learn automatically from its past results?

No.

The bot stores long-term history in `data/picks-log.json` and uses it for reporting, recovery, and audit, but it does not automatically recalibrate thresholds, rewrite prompts, or retrain itself from that history.

## Troubleshooting

### No pre-match tips are being posted

Check these first:

- `FORCE_ANALYSIS` is false and the slate is simply failing gates,
- `THE_ODDS_API_KEY` is valid,
- markets exist at or above `MIN_ACCEPTABLE_ODDS`,
- fixtures are still `scheduled`,
- the fixture was not already marked in the dedup store.

### Reports do not pin

The most likely cause is Telegram permissions. The bot must be allowed to pin messages in the group.

### No halftime or full-time update arrives

Likely reasons:

- the pre-match pick was never published, so no watcher was scheduled,
- the match status never entered the expected provider status inside the polling window,
- the process restarted after the pick was posted and before the watcher fired,
- provider stats or event lookup failed repeatedly during polling.

### Odds show as missing in the tip message

That usually means the formatter could not resolve the same market token against the fetched odds payload, or no odds payload was available for that event at formatting time.

## Disclaimer

This project publishes analytical betting opinions for informational use. It is not financial advice and it does not guarantee outcomes. Bet responsibly.
