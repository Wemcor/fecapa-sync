import { z } from "zod";
import { formatChanged } from "./common.js";

const SOURCE = "portal-config" as const;

const configSchema = z.object({
  url: z.string().min(1),
  cliente: z.string().min(1),
  version: z.string().min(1),
  idm: z.string().min(1),
  token: z.string().min(1),
});

export type SidgadConfig = z.infer<typeof configSchema>;

/**
 * The public portal embeds `const SIDGAD_API_CONFIG = {url, cliente, version, idm, token};`
 * and renders calendars and reports client-side from that API. Returns null
 * when the page has no such constant.
 */
export function extractSidgadConfig(html: string): SidgadConfig | null {
  const raw = /const\s+SIDGAD_API_CONFIG\s*=\s*(\{[^;]+\})\s*;/.exec(html)?.[1];
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw formatChanged(SOURCE, "SIDGAD_API_CONFIG is not valid JSON");
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) throw formatChanged(SOURCE, "SIDGAD_API_CONFIG is incomplete");
  return parsed.data;
}

/** `{url}/{cliente}/{version}/{idm}`, e.g. `https://api.sidgad.com/fecapa/v1/hp`. */
export function apiBaseFromConfig(config: SidgadConfig): string {
  const url = new URL(config.url);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${config.cliente}/${config.version}/${config.idm}`;
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

/** `{apiBase}/{resource}/?id=…&jwt=…` */
export function sidgadUrl(apiBase: string, resource: "calendar" | "report", id: number, token: string): string {
  const url = new URL(`${apiBase.replace(/\/$/, "")}/${resource}/`);
  url.search = new URLSearchParams({ id: String(id), jwt: token }).toString();
  return url.toString();
}
