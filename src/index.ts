export {
  createClient,
  DEFAULT_API_URL,
  DEFAULT_BASE_URL,
  DEFAULT_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  type ClientOptions,
  type FecapaClient,
  type GetReportOptions,
} from "./client.js";
export { ErrorCode, FecapaError, isFecapaError, type FecapaErrorContext, type SourceAttempt } from "./errors.js";
export { sameFixture, type FixtureKey } from "./fixtures.js";
export type { FetchLike } from "./http.js";
export { matchPlayer, normalizePlayerName, type RosterPlayer } from "./players.js";
export type { CalendarSource, ReportSource, SourceContext } from "./sources/types.js";
export type { ReportRequest } from "./parsers/sidgad-json.js";
export { currentSeason, toStartsAt } from "./time.js";
export {
  SOURCE_NAMES,
  type CalendarResult,
  type ExpectTeams,
  type Match,
  type Participant,
  type Report,
  type ReportResult,
  type Side,
  type SourceName,
} from "./types.js";
export { DEFAULT_USER_AGENT, VERSION } from "./version.js";
