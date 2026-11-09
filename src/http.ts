import { FecapaError, redactUrl } from "./errors.js";
import type { SourceName } from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpOptions = {
  fetch: FetchLike;
  userAgent: string;
  /** Minimum pause between the end of one request and the start of the next. */
  delayMs: number;
  timeoutMs: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A deliberately polite HTTP client: one request at a time, a pause between
 * requests, an honest User-Agent, and no browser impersonation.
 */
export class HttpClient {
  private queue: Promise<unknown> = Promise.resolve();
  private lastFinishedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: HttpOptions) {}

  getText(url: string, headers: Record<string, string> = {}): Promise<string> {
    const run = () => this.request(url, headers);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async getJson(url: string, source: SourceName, headers: Record<string, string> = {}): Promise<unknown> {
    const text = await this.getText(url, { accept: "application/json", ...headers });
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new FecapaError("SOURCE_FORMAT_CHANGED", `${source}: response is not valid JSON`, { source, url: redactUrl(url) }, { cause: error });
    }
  }

  private async request(url: string, headers: Record<string, string>): Promise<string> {
    const wait = this.lastFinishedAt + this.options.delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    const safeUrl = redactUrl(url);
    try {
      let response: Response;
      try {
        response = await this.options.fetch(url, {
          headers: { "user-agent": this.options.userAgent, ...headers },
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (error) {
        throw new FecapaError("NETWORK_ERROR", `Request failed: ${safeUrl}`, { url: safeUrl }, { cause: error });
      }
      if (!response.ok) {
        throw new FecapaError("HTTP_ERROR", `HTTP ${response.status} from ${safeUrl}`, { status: response.status, url: safeUrl });
      }
      const text = await response.text();
      if (!text.trim()) throw new FecapaError("EMPTY_RESPONSE", `Empty response from ${safeUrl}`, { url: safeUrl });
      return text;
    } finally {
      this.lastFinishedAt = Date.now();
    }
  }
}
