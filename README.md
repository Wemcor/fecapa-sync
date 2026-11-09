# fecapa-sync

Llibreria de codi obert per llegir calendaris i actes d'hoquei patins de la
FECAPA (Federació Catalana de Patinatge), independent de qualsevol club.

> **Estat:** pre-1.0. L'API pot canviar entre versions 0.x. Encara no està
> publicada a npm. Vegeu [`docs/PLAN.md`](docs/PLAN.md).

## Instal·lació

Requereix Node.js 20.19 o superior. Mentre no estigui a npm, es pot instal·lar
des de GitHub:

```bash
npm install github:jmedinafruitos/fecapa-sync
```

## Ús

```ts
import { createClient, isFecapaError } from "fecapa-sync";

const fecapa = createClient({
  // Opcional. Sense token, la llibreria llegeix la configuració pública del portal.
  token: process.env.FECAPA_SIDGAD_TOKEN,
});

// Calendari d'una competició (el número `liga` de l'URL del portal)
const { source, matches } = await fecapa.getCalendar(4811);
console.log(source); // "sidgad-api" | "portal-config" | "legacy-html"
for (const m of matches) console.log(m.date, m.time, m.homeName, "-", m.awayName, m.startsAt);

// Acta d'un partit, alineació d'un dels dos equips. `report` és null si el partit no ha acabat.
try {
  const { report } = await fecapa.getReport(matches[0].matchId!, { idc: 4811, side: "home" });
  console.log(report?.homeScore, report?.awayScore, report?.participants);
} catch (error) {
  if (isFecapaError(error)) console.error(error.code, error.source); // p. ex. SOURCE_FORMAT_CHANGED
  else throw error;
}
```

Utilitats pures: `toStartsAt`, `currentSeason`, `sameFixture`, `matchPlayer`,
`normalizePlayerName`.

### Bon veí

La llibreria es comporta com un client públic educat: s'identifica amb
`User-Agent: fecapa-sync/<versió> (+https://github.com/jmedinafruitos/fecapa-sync)`,
fa les peticions d'una en una i espera `delayMs` (per defecte 1000 ms) entre
peticions. No falseja cap navegador. Mai no publiquis un token SIDGAD al codi.

## English

Open-source, club-agnostic TypeScript library to read FECAPA (Catalan roller
skating federation) roller hockey fixtures and match reports ("actes").

**Status: pre-1.0.** The API may change between 0.x releases, and the package is
not on npm yet. Install it from GitHub (`npm install github:jmedinafruitos/fecapa-sync`,
Node.js ≥ 20.19).

`createClient(options)` returns `getCalendar(idc)` and
`getReport(matchId, { idc, side, expectTeams? })`. Each call reports which data
source answered: the SIDGAD JSON API with your own token (`sidgad-api`), the
public config embedded in the portal page (`portal-config`), or the old
server-rendered HTML (`legacy-html`), tried in that order. Errors are
`FecapaError`s with a stable `code` (`HTTP_ERROR`, `SOURCE_FORMAT_CHANGED`,
`TEAMS_MISMATCH`, …). The client is polite: honest User-Agent, one request at a
time, a configurable delay between requests. See the Catalan example above and
[`docs/PLAN.md`](docs/PLAN.md).

## Llicència

MIT
