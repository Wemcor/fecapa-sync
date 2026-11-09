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
| `games` | Fixtures: date, time, venue, home/away, match id, group/round, schedule history | `leagues` (explicit ids in 0.2) | SIDGAD `calendar` endpoint ✅ | Dates and times shift during the season |
| `actas` | Final score, both lineups (goalkeepers marked), goals and cards per game | `games` | SIDGAD `report` endpoint ✅ | Fetched once per game after it ends, then final |
| `players` | Players (federation id, name, team, season) | `actas` | Collected from actes at no extra request cost; a `/player/` page exists on the portal (**to investigate**) | As actes arrive |

The two ✅ sources work since 0.1 (`getCalendar`, `getReport`); `games` and
`actas` sync since 0.2. Enabling any other level in 0.2 fails with a message
naming the milestone it's planned for.

## Configuration

A config file (`fecapa-sync.config.json`, plain JSON) or the same object passed
in code. This is the 0.2 shape:

```json
{
  "season": "2026/2027",
  "dataDir": "./fecapa-data",
  "scope": { "leagues": [4811], "teams": [] },
  "levels": { "games": true, "actas": true },
  "refresh": { "games": "24h", "actas": "12h" },
  "limits": { "maxRequestsPerRun": 200, "delayMs": 1000 },
  "token": null
}
```

- `season` defaults to the current one (it changes on 1 July).
- `dataDir` is relative to the config file (or to the working directory for an
  in-code config).
- `scope.leagues`: competition ids (`liga` in the portal URL). Required in 0.2.
  `scope.teams`: team ids; when set, only games involving one of them are
  kept. `scope.categories` and `scope.clubs` arrive in 0.3 and are refused
  until then.
- `levels`: a level turns on the levels it depends on (`actas` → `games`).
  `leagues`, `categories`, `teams`, `clubs` (0.3) and `players` (0.4) are
  refused for now.
- `token`: prefer the `FECAPA_SIDGAD_TOKEN` environment variable. Without a
  token the public portal config is used.

### Floors and retry policy

These are global library defaults, the same for every user.

| Setting | Default | Minimum (lower values are raised) |
|---|---|---|
| `refresh.games` (per league) | 24h | 12h |
| `refresh.actas` (first retry of an acta that wasn't available) | 12h | 6h |
| `limits.delayMs` (pause between requests) | 1000 ms | 1000 ms |
| `limits.maxRequestsPerRun` | 200 | 5 (lower is an error) |

The floors for later levels are already fixed: `leagues` 24h (default 7d),
`categories` 7d (30d), `teams` 24h (7d), `clubs` 7d (30d), `players` 24h (7d).

- **Actas:** requested 3 h after kickoff (or the end of the day + 3 h when the
  time isn't published). If the acta isn't there yet (`not-finished` or
  SIDGAD `NO FILE`), the next attempt waits `refresh.actas`, then doubles
  (12h, 24h, 48h, 96h, then 7 days at most). After 6 attempts (about two weeks)
  the sync gives up on that acta, until the game's kickoff changes. A stored
  final acta is never requested again.
- **Budget:** one calendar or acta can need up to 3 requests when sources fall
  back, so an operation only starts if 3 requests are left. When the budget is
  spent the run ends with status `partial` and the next run continues.
- **Backoff:** any failed run (HTTP 429/5xx, network error, a SIDGAD refusal
  such as `INVALID DOMAIN`, a format change) stops at once, writes no data file,
  and records a backoff in `state.json`: 1 h, then 2 h, 4 h… up to 7 days. Runs
  during the backoff make no request. A successful run with requests clears it.
- **Lock:** `sync.lock` is created exclusively. A lock whose process is gone
  (same host) or older than 6 h is stale and is taken over; otherwise the run
  is skipped.

Examples:

- **A club calendar app:** `games` for its own teams only. A few requests per run.
- **A club stats app:** `games` + `actas` (+ `players` from 0.4) for its own teams.
- **A federation-wide viewer:** all levels (from 0.3). Only with the default
  minimums and a weekly schedule.

## Local store

```
fecapa-data/
  2026-2027/
    games/<idc>.json      # 0.2
    actas/<matchId>.json  # 0.2
    leagues.json  categories.json  teams.json  clubs.json   # 0.3
    players.json                                            # 0.4
  state.json        # last sync per league, next due time, pending actas, backoff, last run
  sync.lock
```

- Records keep the federation's ids as keys, so updates merge in place.
- Each record has `firstSeenAt`/`updatedAt`. A fixture FECAPA republishes with
  a shifted date or swapped sides (even under a new match id) is updated in
  place, not duplicated (`sameFixture`).
- A game stores its current `date`/`time`/`startsAt`/`venue`, `phaseId`/
  `phaseName`/`round`, a `history` of previous schedule values (each with
  `observedAt`, when the change was seen), `rescheduleCount`/`rescheduled`
  (changes of an already published date, time or venue; a first publication
  doesn't count) and `removedAt` when it leaves the calendar. Games are never
  deleted.
- An acta stores both lineups (`home`, `away`) with `isGoalkeeper`, the score,
  venue and group name, and the source that answered.
- Every sync returns a **changeset** (created / updated / removed per level).
  Your application can apply it instead of re-reading everything.
- Writes are atomic (write to a temp file, then rename), so a crash never
  leaves a half-written file. A failed run writes no data file at all.
- **Personal data stays local.** Actes and players include minors. The store
  is meant for your own application. Don't republish it.

## API and CLI

```ts
import { createSync } from "fecapa-sync";

const sync = createSync({ configPath: "./fecapa-sync.config.json" }); // or createSync({ scope: …, … })
await sync.init();                  // one-time full sync of the configured scope
const result = await sync.run();    // scheduled incremental sync; skips what isn't due
result.status;                      // "ok" | "partial" | "skipped" | "failed"
result.changes.games.updated;       // the changeset
const status = await sync.status(); // last/next sync per level, pending actas, backoff (no network)
```

```
npx fecapa-sync init   [--config fecapa-sync.config.json]   # writes a template if the file is missing
npx fecapa-sync sync   [--config …] [--json]                # call this from cron
npx fecapa-sync status [--config …] [--json]
npx fecapa-sync export --level games --format json|csv|ics [--team <id>]   # 0.4
```

`sync` exits 1 when the run failed, 2 on usage or config errors, and 0
otherwise (including nothing due, a spent budget, an active backoff or another
run holding the lock).

The low-level client stays available: `createClient().getCalendar()`,
`getReport()` (one side) and, since 0.2, `getFullReport()` (both lineups in
one request). Report results carry a `status`: `final`, `not-finished` or
`no-file`.

## Milestones

| Version | Scope | Done when |
|---|---|---|
| **0.1** ✅ | Client: calendar + acta, three sources tried in order, zod validation, typed errors, polite client | Fixture tests and CI green (PR #1) |
| **0.2** ✅ | Sync engine: config file, local JSON store, `state.json`, minimum intervals, request budget, backoff, lock, changesets. Levels `games` and `actas`. CLI `init`/`sync`/`status` | A cron job keeps a team's games and actes up to date; a second run with nothing due makes 0 requests (PR #3) |
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

## Data notes

Facts about FECAPA's data from people who work with it, checked where
possible against the live portal and SIDGAD API (November 2026, public
competitions only).

- **Postponed or cancelled games.** FECAPA never marks a game as postponed or
  cancelled. The only signal is that its date, time or venue changes, or that
  it disappears from the calendar. The store keeps both: a `history` of
  previous schedule values with a derived `rescheduled`/`rescheduleCount`, and
  `removedAt` for games that are no longer listed.
- **Groups and rounds.** One competition id (`idc`) is published as several
  groups. The calendar list contains separator rows with `idp` "0":
  `dia_partido` "FASE" opens a group (`hora_partido` holds the group id,
  `home_name` its name, e.g. "BENJAMÍ PLATA 1") and "JORNADA" opens a round
  (`home_name` "JORNADA n"). Games store them as `phaseId`, `phaseName` and
  `round`. The report's `tournament_name` is the same group name. Group names
  carry the category (e.g. a "FEM …" prefix), which 0.3 will use.
- **Venue.** The calendar's `pista` field is the venue. It was empty (`null`)
  in every competition checked, where the portal has `has_pistas: false`; the
  report's `venue_info` was filled. Games store `venue` from the calendar and
  actas store `venue` from the report.
- **Games without a date.** No game with teams but no date was seen. One
  competition had a placeholder row with a real `idp` and empty date, time,
  teams and ids; it's skipped. A game with both teams and an empty or
  `00/00/0000` date is kept with `date`, `time` and `startsAt` set to `null`;
  any other unparseable date is `SOURCE_FORMAT_CHANGED`. No acta is requested
  for a game without a date.
- **`NO FILE`.** The report endpoint answers HTTP 200 `{"status":"NO FILE"}` for
  future matches, for matches whose acta isn't uploaded yet and for unknown ids
  alike. The client returns it as `status: "no-file"` (no error, no fallback to
  the next source) and the sync retries it later with the policy above.
  Finished matches answer the full report with `game_completed: "true"`.
- **Goalkeepers.** The acta is the only place a goalkeeper is recorded. The
  portal's roller hockey acta renders its lineup table client-side from the
  report JSON; its "P" column shows `player_role`, and the printable acta
  prints "P" only when `player_role === "P"`. In live actas, goalkeepers have
  `player_role: "P"` and everyone else `null`. `home_goalies`/`away_goalies`
  were empty in every roller hockey acta checked; the portal only reads them in
  another sport's acta. A player listed there is still treated as a goalkeeper
  and added if missing from the roster. The old server-rendered acta has the
  same "P" in the second cell of a player row. Both parsers set
  `Participant.isGoalkeeper`.
- **Gender.** There is no gender field anywhere. The only rule: teams in a
  `FEM…` category, or in a league whose name contains "Femenina", are women's
  teams. Everything else is unknown, because youth leagues can be mixed. This
  needs the 0.3 league/category levels, so 0.2 only reserves the shape for team
  records: `gender: "female" | "unknown"` with `genderSource: "inferred"`
  (types `Gender`, `GenderInfo`).
- **Club ids.** Calendar games carry `home_club_id`/`away_club_id`, and newer
  reports `home_club_id`/`away_club_id` too. Not stored yet; a lead for the
  0.3 `clubs` level.
- **Results in the calendar.** Calendar games carry `result` ("3:2", empty
  until played). Not used yet; it could tell the sync when an acta is likely
  available and save `NO FILE` retries.

## Open questions

- Is there a SIDGAD endpoint for leagues/competitions, clubs or team rosters?
  Find it from the portal's own requests before scraping anything.
- **Other modalities:** the SIDGAD path includes a client and a modality
  (`fecapa`/`hp`). Making them options may support other sports. Not verified.
