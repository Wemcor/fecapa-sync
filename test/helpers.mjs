import { readFileSync } from 'node:fs';

const root = new URL('../fixtures/', import.meta.url);

export const fixture = (path) => readFileSync(new URL(path, root), 'utf8');
export const jsonFixture = (path) => JSON.parse(fixture(path));

/**
 * A fake fetch. `routes` is a list of [predicate, responder]; the first route
 * whose predicate matches the URL answers. Unmatched URLs fail the test loudly.
 * Every call is recorded in `calls` with its URL and lower-cased headers.
 */
export function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url: String(url), headers });
    for (const [match, respond] of routes) {
      const hit = typeof match === 'function' ? match(String(url)) : String(url).includes(match);
      if (hit) return typeof respond === 'function' ? respond(String(url), headers) : respond;
    }
    throw new Error(`Unexpected request in test: ${url}`);
  };
  return { fetch, calls };
}

export const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });
export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
