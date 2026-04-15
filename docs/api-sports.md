# API-Sports Integration Notes

This file documents the exact API-Sports endpoints and status semantics used by the app after the provider migration. API-Sports is now the only sports-data provider used for fixture discovery, enrichment, live polling, and result resolution.

## Authentication

Official API-Sports docs state:

- football base URL: `https://v3.football.api-sports.io`
- basketball base URL: `https://v1.basketball.api-sports.io`
- requests are `GET`
- authentication header: `x-apisports-key`

The app reads the key from `APISPORTS_API_KEY` and applies the timeout from `APISPORTS_TIMEOUT_MS`.

## Football

Official docs source used during implementation:

- `https://www.api-football.com/documentation-v3`

### Endpoints used by the app

1. `GET /fixtures?date=YYYY-MM-DD`
   Used for daily fixture discovery.
   The implementation filters locally by tracked competition and team names.

2. `GET /fixtures?id={fixtureId}`
   Used for live polling, halftime/full-time status checks, and final result resolution.
   The response includes embedded `events`, `lineups`, `statistics`, and `players` blocks.

3. `GET /fixtures/headtohead?h2h={homeTeamId}-{awayTeamId}`
   Used for lightweight pre-match H2H context when available on the current plan.

4. `GET /injuries?fixture={fixtureId}`
   Used for fixture-scoped injury context during enrichment.

### Status values used by the app

Official fixture statuses used by the app include:

- Scheduled: `TBD`, `NS`
- In play: `1H`, `HT`, `2H`, `ET`, `BT`, `P`, `LIVE`, `SUSP`, `INT`
- Finished: `FT`, `AET`, `PEN`
- Non-played states: `PST`, `CANC`, `ABD`, `AWD`, `WO`

Implementation behavior:

- halftime watcher fires on `HT`
- full-time watcher and report resolution accept `FT`, `AET`, and `PEN`
- raw provider status is stored and logged as returned by the API

### Football league IDs used in the code

| Competition | API-FOOTBALL league id |
| --- | --- |
| Premier League | `39` |
| La Liga | `140` |
| Serie A | `135` |
| Bundesliga | `78` |
| Ligue 1 | `61` |
| UEFA Champions League | `2` |
| UEFA Europa League | `3` |

### Free-plan caveat

During live validation with the current account:

- `GET /fixtures?id={fixtureId}` worked for current fixtures
- `GET /fixtures?date=YYYY-MM-DD` worked for the current day
- `GET /fixtures?date=YYYY-MM-DD&league={id}` returned `season is required`
- `GET /fixtures?date=YYYY-MM-DD&league={id}&season=2025` returned a plan error for the current season

Because of that, the app resolves football fixtures with the broader `date` query and then switches to direct `id` lookups for the live lifecycle.

## Basketball

Official docs source used during implementation and validation:

- `https://api-sports.io/documentation/basketball/v1`

### Endpoints used by the app

1. `GET /games?date=YYYY-MM-DD`
   Used for daily fixture discovery.

2. `GET /games?id={gameId}`
   Used for live polling, halftime/full-time status checks, and final result resolution.
   The response includes `status.short`, team identities, and quarter-by-quarter plus total scoring.

3. `GET /games?h2h={homeTeamId}-{awayTeamId}`
   Used for lightweight pre-match H2H context when available.

### Status values used by the app

The basketball docs list statuses including:

- `NS`
- `Q1`
- `Q2`
- `Q3`
- `Q4`
- `OT`
- `BT`
- `HT`
- `FT`
- `AOT`
- `POST`
- `CANC`

Implementation behavior:

- halftime watcher fires on `HT`
- full-time watcher and report resolution accept `FT` and `AOT`
- quarter scores are converted into lightweight `EventStat[]` entries so narratives still receive structured numeric context

### Basketball league IDs used in the code

| Competition | API-BASKETBALL league id |
| --- | --- |
| NBA | `12` |
| EuroLeague | `120` |

### Free-plan caveat

During live validation with the current account:

- `GET /games?date=YYYY-MM-DD` worked and returned the current-day slate
- `GET /games?id={gameId}` worked for resolved current-day games
- `GET /games?date=YYYY-MM-DD&league={id}` returned `season is required`
- `GET /games?date=YYYY-MM-DD&league={id}&season=2025-2026` returned a plan error for the current season

Because of that, the app resolves basketball games with the broader `date` query and then switches to direct `id` lookups for the live lifecycle.

## Runtime strategy in the app

The current runtime is API-Sports only:

1. Fixture discovery builds internal ids in the form `api-football_{id}` or `api-basketball_{id}`.
2. Each published pick stores:
   - `liveDataProvider`
   - `liveDataFixtureId`
3. Halftime watcher, full-time watcher, and weekly/monthly result resolution reuse those persisted values.
4. If the mapping cannot be resolved, the app logs the failure and skips the live-data action instead of falling back to another provider.

This keeps the data flow consistent across fixture discovery, enrichment, live tracking, and final reports.
