# SWIMMINGPOOL — pools.trade, filtered (swimmingpool.lol)

Filters, new-pairs feed, token pages, and creator rap sheets (wallet + X handle cross-ref)
across Robinhood Chain launchpads (pools.trade + noxa, adapter-based)'s undocumented tRPC API. Robinhood Chain (4663).

## Deploy
1. Push to GitHub → import in Vercel.
2. Env vars: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
   (works without Redis too — just no cache & no X-handle cross-ref index).
3. Done. Frontend at `/`, endpoints: `/api/feed`, `/api/token?ca=0x…`, `/api/creator?q=0x…|handle`.

## How the X cross-ref works
pools.trade caps every list at 100 rows, no pagination. `/api/feed` accumulates every
token it ever sees into a Redis hash (`seen:v1`). Over days that becomes the full index —
`/api/token` scans it to catch the same X handle deploying from different wallets.

## Guardrails
- API is undocumented: every response is shape-checked, partial failures degrade instead of crash.
- Local preview: open index.html directly (file://) → demo data mode.
