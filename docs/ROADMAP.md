# Roadmap

`fecapa-sync` reads FECAPA (Federació Catalana de Patinatge) roller hockey
fixtures and match reports. It works for any club and any team. It doesn't
store data, schedule jobs or know anything about the application that uses it.

## Principles

- **Library + CLI only.** No hosted service. Applications decide where data is
  stored and when it is refreshed.
- **Club-agnostic.** No club, team or competition ids in code or docs, except
  as public examples.
- **Polite client.** An honest User-Agent, one request at a time, a
  configurable delay, no browser spoofing, no committed tokens.
- **No real personal data.** Match reports involve minors. Fixtures and tests
  use invented names and player ids (≥ 900000) only.
- **Fail loudly.** A change on FECAPA's side must surface as
  `SOURCE_FORMAT_CHANGED` with the source name, never as an empty result.
- **MIT licensed.**

## Done (0.1)

- Client with three sources tried in order: `sidgad-api` (with a token),
  `portal-config` (reads the API config from the public portal page) and
  `legacy-html`.
- zod validation of SIDGAD JSON responses; typed `FecapaError` codes.
- Pure utilities: `toStartsAt`, `currentSeason`, `sameFixture`, `matchPlayer`,
  `normalizePlayerName`.
- Fixture-based tests and CI on Node 20 and 22.

## Next: discovery and CLI

- `listCompetitions(season?)`, `listTeams(idc)`, `findTeam(query)`, so users
  don't have to dig ids out of the portal's URLs. Find out whether the portal
  or the API has an index endpoint; otherwise derive teams from calendars.
- An optional on-disk `cache`.
- CLI (`npx fecapa-sync …`):

  ```
  calendar  --league <idc> [--team <id>] --format json|csv|ics [--out file]
  report    --match <id> --league <idc> [--side home|away] --format json
  teams     --league <idc>
  competitions [--season 2026/2027]
  find-team <query>
  ```

Done when someone who has never used the library can export a team's ICS
calendar from the README alone.

## Next: contributions and releases

- `fecapa-sync capture <calendar|report> <id> --out fixtures/…` saves a live
  response, with player names and ids anonymised deterministically.
- Every parser is tested against all stored fixtures, old and new, so a fix for
  a new format can't break an old one.
- `live-canary` GitHub Action (daily cron, plus a manual trigger) runs against
  a few public competitions. When it fails, it opens or updates an issue
  labelled `source-drift` with the error code and the source. It is not a
  required PR check.
- `CONTRIBUTING.md` with a "FECAPA changed" playbook: capture → failing test →
  fix or add a source → PR → changeset (patch release).
- Issue templates (`source-drift`, `feature`), CODEOWNERS, branch protection,
  changesets and an npm publish workflow, then the first npm release.

Done when a release is on npm and a simulated format change opens a
`source-drift` issue.

## Open questions

- **Goalkeepers:** the SIDGAD report JSON has `home_goalies`/`away_goalies`
  arrays. Only `*_roster` is read today. Check against a match that lists
  goalkeepers whether they appear only in the goalies arrays.
- **Unplayed matches:** check whether an existing but unplayed match answers
  `{"status":"NO FILE"}`. If so, `getReport` should return `null` instead of
  `SOURCE_REJECTED`.
- **Other modalities:** the SIDGAD path includes a client and a modality
  (`fecapa`/`hp`). Making them options may support other sports or federations.
  Not verified.
