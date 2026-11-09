# Correctness and refusal handling

- Finished reports require both scores. Missing scores raise
  `SOURCE_FORMAT_CHANGED`; a genuine numeric or string zero is still valid.
  Optional player counters retain their existing defaults.
- HTTP 403/429 and semantic access refusals stop the current operation before
  another source is tried. HTTP errors expose `retryAfterMs` when the server
  sends a valid `Retry-After` delay or HTTP date.
- The sync engine persists the later of its exponential backoff and the
  server's requested retry time. Applications using `createClient()` directly
  must persist their own backoff and share locks/budgets across processes.
- Calendar dates are checked against real day/month combinations, including
  leap years. Hours outside 00:00–23:59 cannot shift a fixture into another day.

Regression cases are in `test/hardening.test.mjs`. They use invented fixtures
and a mocked HTTP transport; no live requests are required.
