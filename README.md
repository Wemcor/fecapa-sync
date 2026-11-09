# fecapa-sync

Llibreria de codi obert per mantenir una còpia local en JSON dels calendaris i
les actes d'hoquei patins de la FECAPA (Federació Catalana de Patinatge),
independent de qualsevol club.

> **Estat:** pre-1.0. L'API pot canviar entre versions 0.x. Encara no està
> publicada a npm. Vegeu [`docs/ROADMAP.md`](docs/ROADMAP.md).

> **Sincronitza poc, no sovint.** L'objectiu és una còpia local en JSON: una
> sincronització completa inicial i després sincronitzacions programades
> (una o dues per setmana) que només baixen el que encara pot canviar.
> Sincronitzar-ho tot sovint pot bloquejar la teva IP o saturar el servidor de
> la FECAPA per a tothom. Vegeu [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Instal·lació

Requereix Node.js 20.19 o superior. Mentre no estigui a npm, es pot instal·lar
des de GitHub:

```bash
npm install github:jmedinafruitos/fecapa-sync
```

## Sincronització (0.2)

Crea `fecapa-sync.config.json` (o executa `npx fecapa-sync init`, que en crea
una plantilla si no existeix):

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

- `scope.leagues`: els números de competició (el paràmetre `liga` de l'URL del
  portal). `scope.teams`: ids d'equip opcionals per quedar-te només amb els
  partits d'aquests equips.
- `levels`: en aquesta versió només `games` i `actas` (`actas` activa `games`).
  Els altres nivells arriben a la 0.3/0.4 i ara donen un error explicatiu.
- `token`: millor a la variable d'entorn `FECAPA_SIDGAD_TOKEN`. Sense token es
  fa servir la configuració pública del portal. No publiquis mai un token.

```bash
npx fecapa-sync init     # primera sincronització completa
npx fecapa-sync sync     # incremental: només el que toca; per al cron
npx fecapa-sync status   # estat local, sense xarxa
```

Cron recomanat, una o dues vegades per setmana (dilluns per recollir les actes
del cap de setmana, dijous pels canvis de calendari):

```cron
0 3 * * 1,4  cd /srv/app && npx fecapa-sync sync >> fecapa-sync.log 2>&1
```

`sync` surt amb codi 1 si la sincronització falla, 2 si la configuració és
incorrecta, i 0 en els altres casos (també si no hi havia res pendent, si s'ha
acabat el pressupost de peticions o si està en pausa per errors).

Des del codi:

```ts
import { createSync } from "fecapa-sync";

const sync = createSync({ configPath: "./fecapa-sync.config.json" });
const result = await sync.run();
console.log(result.status, result.requests, result.changes.games.updated);
```

Les dades queden a `fecapa-data/2026-2027/games/<liga>.json` i
`fecapa-data/2026-2027/actas/<partit>.json`. La FECAPA no marca mai un partit
com a ajornat o suspès: cada partit guarda la data, hora i pista actuals, un
historial (`history`) dels valors anteriors i `rescheduled`. Un partit que
desapareix del calendari es conserva amb `removedAt`. Cada acta té les dues
alineacions, amb `isGoalkeeper` per als porters. Les actes contenen dades de
menors: no les republiquis.

### Límits que imposa la llibreria

| | Per defecte | Mínim |
|---|---|---|
| `refresh.games` (per competició) | 24h | 12h |
| `refresh.actas` (primer reintent d'una acta no disponible) | 12h | 6h |
| `limits.delayMs` | 1000 ms | 1000 ms |
| `limits.maxRequestsPerRun` | 200 | 5 |

Els valors per sota del mínim s'apugen al mínim. Una acta es demana 3 hores
després de l'inici del partit; si encara no hi és, es torna a provar al cap de
12h, 24h, 48h, 96h i 7 dies, i després de 6 intents es deixa fins que el
partit canviï de data o d'hora. Una acta final no es torna a demanar mai. Un error
(HTTP 429/5xx, rebuig de SIDGAD, canvi de format) atura la sincronització
sense tocar les dades i posa una pausa d'1 h, 2 h, 4 h… fins a 7 dies. Vegeu
[`docs/ROADMAP.md`](docs/ROADMAP.md).

## Client de baix nivell

```ts
import { createClient, isFecapaError } from "fecapa-sync";

const fecapa = createClient({
  // Opcional. Sense token, la llibreria llegeix la configuració pública del portal.
  token: process.env.FECAPA_SIDGAD_TOKEN,
});

// Calendari d'una competició (el número `liga` de l'URL del portal)
const { source, matches } = await fecapa.getCalendar(4811);
console.log(source); // "sidgad-api" | "portal-config" | "legacy-html"
for (const m of matches) console.log(m.date, m.time, m.homeName, "-", m.awayName, m.venue, m.phaseName);

// Acta d'un partit amb les dues alineacions. `report` és null si no és final:
// `status` és "not-finished" o "no-file" (SIDGAD encara no té l'acta).
try {
  const { status, report } = await fecapa.getFullReport(matches[0].matchId!, { idc: 4811 });
  if (status === "final") console.log(report.homeScore, report.awayScore, report.home.filter((p) => p.isGoalkeeper));
} catch (error) {
  if (isFecapaError(error)) console.error(error.code, error.source); // p. ex. SOURCE_FORMAT_CHANGED
  else throw error;
}
```

`getReport(matchId, { idc, side })` retorna només un dels dos equips.
Utilitats pures: `toStartsAt`, `currentSeason`, `sameFixture`, `matchPlayer`,
`normalizePlayerName`.

### Bon veí

La llibreria es comporta com un client públic educat: s'identifica amb
`User-Agent: fecapa-sync/<versió> (+https://github.com/jmedinafruitos/fecapa-sync)`,
fa les peticions d'una en una i espera `delayMs` (per defecte 1000 ms) entre
peticions. No falseja cap navegador. Mai no publiquis un token SIDGAD al codi.

Consulteu també [`docs/HARDENING.md`](docs/HARDENING.md) per a la validació de marcadors i dates i el tractament de refusos.

## English

Open-source, club-agnostic TypeScript library that keeps a local JSON copy of
FECAPA (Catalan roller skating federation) roller hockey fixtures and match
reports ("actes").

**Status: pre-1.0.** The API may change between 0.x releases, and the package is
not on npm yet. Install it from GitHub (`npm install github:jmedinafruitos/fecapa-sync`,
Node.js ≥ 20.19).

**Sync (0.2).** Write `fecapa-sync.config.json` as in the Catalan example above
(`scope.leagues` are the portal's `liga` ids; `scope.teams` optionally keeps
only some teams' games; levels `games` and `actas`), then run
`npx fecapa-sync init` once and `npx fecapa-sync sync` from cron once or twice a
week, e.g. `0 3 * * 1,4`. In code: `createSync({ configPath })` or
`createSync(configObject)` returns `init()`, `run()` and `status()`; every run
returns a changeset. A second run with nothing due makes no request. The
library enforces floors: games are refreshed at most every 12h (default 24h),
an unavailable acta is retried after 12h (minimum 6h), 24h, 48h, 96h and 7d,
then given up after 6 attempts until the game is rescheduled; a final acta is
never refetched; 1 s between requests; at most `maxRequestsPerRun` requests
(default 200). Any failure (HTTP 429/5xx, a SIDGAD refusal, a format change)
stops the run without touching the data and backs off for 1 h, doubling up to
7 days. FECAPA never marks a game as postponed or cancelled, so games keep a
`history` of previous date/time/venue values, a `rescheduled` flag and
`removedAt` when they leave the calendar. Actas hold both lineups with
`isGoalkeeper`. `sync` exits 1 on failure and 2 on a config error.

**Client.** `createClient(options)` returns `getCalendar(idc)`,
`getReport(matchId, { idc, side, expectTeams? })` and
`getFullReport(matchId, { idc, expectTeams? })`. Report results carry a
`status` (`final`, `not-finished`, or `no-file` when SIDGAD has no acta yet).
Each call reports which data source answered: the SIDGAD JSON API with your own
token (`sidgad-api`), the public config embedded in the portal page
(`portal-config`), or the old server-rendered HTML (`legacy-html`), tried in
that order. Errors are `FecapaError`s with a stable `code` (`HTTP_ERROR`,
`SOURCE_FORMAT_CHANGED`, `TEAMS_MISMATCH`, `INVALID_CONFIG`, …). The client is
polite: honest User-Agent, one request at a time, a configurable delay between
requests.

**Sync rarely, not often.** Syncing everything often can get your IP blocked or
overload FECAPA's servers for everyone. Actes include minors' data: keep the
store for your own application. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Llicència

MIT
