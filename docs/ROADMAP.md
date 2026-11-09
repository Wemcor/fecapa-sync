# Roadmap

`fecapa-sync` keeps a **local JSON copy** of FECAPA (Federació Catalana de
Patinatge) roller hockey data: clubs, categories, leagues, teams, players,
games and match reports ("actes"). It works for any club and any team.

You run it where your application lives. The first run does a **one-time full
sync** of the data you asked for. After that, **scheduled syncs** only fetch
what can still change and merge it into the same JSON files. Your application
reads those files and never talks to FECAPA directly.

## ⚠️ Sync rarely, not often

FECAPA's public portal and the SIDGAD API behind it are shared by every club,
federation official and family in Catalonia. They are not built for bulk
downloads. **Syncing all data often will get your IP blocked, or worse,
overload the origin for everyone.**

The library is designed around that:

- **One full sync, then incremental updates.** Data that cannot change again
  is never fetched again. A finished acta, for example, is final.
- **Minimum refresh intervals per level, enforced by the library.** If your
  cron runs every 5 minutes, the library still won't refetch games more often
  than their minimum interval. It answers from the local copy and reports that
  nothing was due.
- **A request budget per run** (`maxRequestsPerRun`). When the budget is spent,
  the run stops cleanly and continues next time.
- **One request at a time,** with a delay between requests (default 1 s), an
  honest User-Agent and no browser spoofing.
- **Back off on refusals.** HTTP 429/5xx or a SIDGAD refusal (`INVALID DOMAIN`,
  …) stops the run and pushes the next attempt back. It never retries in a
  tight loop.
- **A lock file,** so two runs never overlap.

Recommended schedule: **once or twice a week** for most clubs (for example
Monday 03:00 to pick up the weekend's actes, and Thursday 03:00 for fixture
changes). More often than daily is almost never useful.

## Data levels

Each level can be switched on or off. Turning a level on also turns on the
levels it depends on.

| Level | What it holds | Depends on | Source | Changes how often |
|---|---|---|---|---|
| `leagues` | Competitions for a season (id `idc`, name, phase) | — | **To investigate**: no index endpoint known yet | Start of season, phase changes |
| `categories` | Age/level categories (Prebenjamí, Benjamí, …, Sènior) and which leagues belong to each | `leagues` | Derived from league names/metadata; **to investigate** | Once a season |
| `teams` | Teams in each league (id, name) | `leagues` | Derived from league calendars (home/away ids and names) | Rarely within a season |
| `clubs` | Clubs and the teams they field | `teams` | **To investigate**: club ids may exist in SIDGAD; otherwise grouped from team names | Rarely |
| `games` | Fixtures: date, time, home/away, match id, status | `leagues` | SIDGAD `calendar` endpoint ✅ | Dates and times shift during the season |
| `actas` | Final score, lineups, goals and cards per game | `games` | SIDGAD `report` endpoint ✅ | Fetched once per game after it ends, then final |
| `players` | Players (federation id, name, team, season) | `actas` | Collected from actes at no extra request cost; a `/player/` page exists on the portal (**to investigate**) | As actes arrive |

The two ✅ sources already work in 0.1 (`getCalendar`, `getReport`).

## Configuration

A config file (`fecapa-sync.config.json`) or the same object passed in code:

```jsonc
{
  "season": "2026/2027",
  "dataDir": "./fecapa-data",

  // What to sync. Leave a list empty to mean "all within the other filters".
  "scope": {
    "categories": ["Benjamí", "Aleví"],
    "leagues": [4811],
    "clubs": [],
    "teams": []
  },

  // Which levels this implementation needs.
  "levels": {
    "leagues": true,
    "categories": true,
    "teams": true,
    "clubs": false,
    "games": true,
    "actas": true,
    "players": false
  },

  // How often each level may be refreshed. Values below the library's
  // minimums are raised to the minimum.
  "refresh": {
    "leagues": "7d",
    "categories": "30d",
    "teams": "7d",
    "clubs": "30d",
    "games": "24h"
  },

  "limits": { "maxRequestsPerRun": 200, "delayMs": 1000 },
  "token": null
}
```

Examples:

- **A club calendar app:** `games` for its own teams only. A few requests per run.
- **A club stats app:** `games` + `actas` + `players` for its own teams.
- **A federation-wide viewer:** all levels. Only with the default minimums
  and a weekly schedule.

## Local store

```
fecapa-data/
  2026-2027/
    leagues.json
    categories.json
    teams.json
    clubs.json
    players.json
    games/<idc>.json
    actas/<matchId>.json
  state.json        # last sync per level and per league, next due time, backoff
  sync.lock
```

- Records keep the federation's ids as keys, so updates merge in place.
- Each record has `firstSeenAt`/`updatedAt`. A fixture FECAPA republishes with
  a shifted date or swapped sides is updated in place, not duplicated
  (`sameFixture`).
- Every sync returns a **changeset** (created / updated / removed per level).
  Your application can apply it instead of re-reading everything.
- Writes are atomic (write to a temp file, then rename), so a crash never
  leaves a half-written file.
- **Personal data stays local.** Actes and players include minors. The store
  is meant for your own application. Don't republish it.

## API and CLI (target)

```ts
import { createSync } from "fecapa-sync";

const sync = createSync({ configPath: "./fecapa-sync.config.json" });
await sync.init();                 // one-time full sync of the configured scope
const changes = await sync.run();  // scheduled incremental sync; skips what isn't due
const status = await sync.status(); // last/next sync per level, budget used, backoff
```

```
npx fecapa-sync init   [--config fecapa-sync.config.json]
npx fecapa-sync sync   [--config …]          # call this from cron
npx fecapa-sync status [--config …]
npx fecapa-sync export --level games --format json|csv|ics [--team <id>]
```

The low-level `createClient().getCalendar()` / `getReport()` stay available.

## Milestones

| Version | Scope | Done when |
|---|---|---|
| **0.1** ✅ | Client: calendar + acta, three sources tried in order, zod validation, typed errors, polite client | Fixture tests and CI green (PR #1) |
| **0.2** | Sync engine: config file, local JSON store, `state.json`, minimum intervals, request budget, backoff, lock, changesets. Levels `games` and `actas`. CLI `init`/`sync`/`status` | A cron job keeps a team's games and actes up to date; a second run with nothing due makes 0 requests |
| **0.3** | Investigate and add `leagues`, `categories`, `teams`, `clubs` | A new user can go from a club or category name to synced games without knowing any id |
| **0.4** | `players` (from actes; the `/player/` page if useful). `export` to JSON/CSV/ICS | A team's ICS calendar from the README alone |
| **1.0** | Contributions and release: `capture` (anonymised fixtures), weekly `live-canary` that opens a `source-drift` issue, CONTRIBUTING with a "FECAPA changed" playbook, issue templates, changesets, npm publish | Published on npm; a simulated format change opens an issue |

## Principles

- **Library + CLI only.** No hosted service.
- **Club-agnostic.** No club, team or competition ids in code or docs, except
  as public examples.
- **Respect the origin.** See the warning above. Any feature that adds
  requests needs a reason and a budget.
- **No real personal data in the repo.** Fixtures and tests use invented names
  and player ids ≥ 900000.
- **Fail loudly.** A change on FECAPA's side shows up as
  `SOURCE_FORMAT_CHANGED` with the source name, never as an empty result.
  A failed run leaves the previous local data untouched.
- **MIT licensed.**

## Open questions

- Is there a SIDGAD endpoint for leagues/competitions, clubs or team rosters?
  Find it from the portal's own requests before scraping anything.
- **Goalkeepers:** the report JSON has `home_goalies`/`away_goalies` arrays.
  Only `*_roster` is read today. Check against a match that lists goalkeepers.
- **Unplayed matches:** does an existing but unplayed match answer
  `{"status":"NO FILE"}`? If so, treat it as "not available yet" and retry
  after the game, not as an error.
- **Game status:** can the calendar tell a postponed or cancelled game from a
  scheduled one? That decides when an acta is worth requesting.
- **Other modalities:** the SIDGAD path includes a client and a modality
  (`fecapa`/`hp`). Making them options may support other sports. Not verified.
