// GECKOTERMINAL adapter — the primary source. One API that sees every pool on Robinhood Chain
// regardless of launchpad, with accurate numbers and real pagination.
//
// Why this replaced the pile of per-launchpad adapters: it supplies market cap, FDV, liquidity,
// 24h volume, 24h change, genuine pool-creation timestamps, AND 1h buyer counts — the last of
// which no other source exposed. Launchpad attribution still comes from the deploying factory.
//
// Free tier is ~30 calls/min, so page counts are kept modest.

import { valid } from './_shape.js';

const B = 'https://api.geckoterminal.com/api/v2/networks/robinhood';
const QUOTE_SYMS = new Set(['WETH', 'USDG', 'USDE', 'USDC', 'USDT', 'DAI', 'WBTC']);

const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;
const CACHE_KEY = 'gecko:pools:v1';
const CACHE_TTL = 90;           // seconds — comfortably longer than the feed's own cache
const STALE_KEY = 'gecko:pools:stale';
const LOCK_KEY  = 'gecko:pools:lock';

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    return (await r.json()).result;
  } catch { return null; }
}

async function j(path) {
  const r = await fetch(B + path, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`gecko ${path} ${r.status}`);
  return r.json();
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// "CASHCAT / WETH 0.293%" → base symbol
function baseSymbol(name) {
  if (!name) return null;
  const left = String(name).split('/')[0].trim();
  return left || null;
}

function norm(p) {
  const a = p.attributes || {};
  const rel = p.relationships || {};
  // base_token id looks like "robinhood_0xabc…"
  const id = rel.base_token?.data?.id || '';
  const ca = id.includes('_') ? id.split('_').pop() : null;
  if (!ca || !/^0x[0-9a-fA-F]{40}$/.test(ca)) return null;

  const sym = baseSymbol(a.name);
  if (!sym) return null;
  if (QUOTE_SYMS.has(sym.toUpperCase())) return null;      // WETH/USDG pools are the quote side

  const tx1h = a.transactions?.h1 || {};
  return {
    ca,
    sym,
    name: sym,                                             // GT carries no separate long name
    launchpad: null,                                       // set by factory attribution in feed.js
    creator: null,
    x: null, telegram: null, website: null,
    // GT sends 0 (not null) when market cap is unknown — || so it falls through to FDV,
    // which is why NOVAAI ($54M FDV) was rendering as $0.
    mcapUsd: num(a.market_cap_usd) || num(a.fdv_usd),
    volUsd: num(a.volume_usd?.h24),
    liqUsd: num(a.reserve_in_usd),
    change24h: num(a.price_change_percentage?.h24),
    holders: null,                                         // GT has none — Blockscout supplies it
    buyers1h: tx1h.buyers != null ? Number(tx1h.buyers) : null,
    createdAt: a.pool_created_at ? new Date(a.pool_created_at).getTime() : null,
    status: null,
    imageUrl: null,                                        // filled from icon cache / dexscreener
    imageEmoji: null, imageHue: null, spark: null,
    priceUsd: num(a.base_token_price_usd),
    _pool: a.address || null,
  };
}

// keep the deepest pool per token — a token can have several fee tiers
function collect(map, pools) {
  for (const p of (pools || [])) {
    const r = norm(p);
    if (!r || !valid(r)) continue;
    const k = r.ca.toLowerCase();
    const prev = map.get(k);
    if (!prev || (r.liqUsd ?? 0) > (prev.liqUsd ?? 0)) map.set(k, r);
  }
}

// GeckoTerminal's free tier allows roughly 30 calls/minute. Each uncached run costs
// topPages + newPages calls, so hitting it on every feed request meant a couple of quick
// refreshes blew the limit, gecko 429'd, and the feed silently collapsed to pools+noxa —
// which is exactly the flip-flopping between a good TOP and a noxa-only one.
//
// So: cache the result for 90s (longer than the feed's own cache), never throw, and fall back
// to the last known-good set if a run comes back thin. The list stays stable across refreshes.
export async function fetchFeed({ topPages = 10, newPages = 5 } = {}) {
  const cached = await redis(['GET', CACHE_KEY]);
  if (cached) { try { return JSON.parse(cached); } catch {} }

  // THUNDERING-HERD GUARD. Without this, several visitors arriving on a cold cache would each
  // launch a full page sweep at once — the very burst that trips the rate limit. The first
  // request takes a short lock; everyone else serves the last known-good set and moves on.
  const gotLock = await redis(['SET', LOCK_KEY, '1', 'NX', 'EX', '25']);
  if (!gotLock) {
    const stale = await redis(['GET', STALE_KEY]);
    if (stale) { try { return JSON.parse(stale); } catch {} }
    return [];                       // nothing cached yet: contribute nothing rather than pile on
  }

  const out = new Map();
  const jobs = [];
  for (let i = 1; i <= topPages; i++) jobs.push(j(`/pools?page=${i}&sort=h24_volume_usd_desc`));
  for (let i = 1; i <= newPages; i++) jobs.push(j(`/new_pools?page=${i}`));
  const res = await Promise.allSettled(jobs);
  let ok = 0;
  for (const s of res) if (s.status === 'fulfilled') { ok++; collect(out, s.value?.data); }

  const rows = [...out.values()];

  // A short run means rate limiting, not an empty chain. Compare against the last known-good set
  // and keep the better one — otherwise a half-throttled sweep overwrites a healthy cache and the
  // feed quietly shrinks. `ok` tells us how many page requests actually succeeded.
  const stale = await redis(['GET', STALE_KEY]);
  let best = rows;
  if (stale) {
    try {
      const prev = JSON.parse(stale);
      // treat the fresh run as degraded if it lost a meaningful share of the previous set
      if (Array.isArray(prev) && prev.length > rows.length * 1.25) best = prev;
    } catch {}
  }

  // only promote a fresh result to cache when it wasn't degraded
  if (rows.length && best === rows) {
    await redis(['SET', CACHE_KEY, JSON.stringify(rows), 'EX', String(CACHE_TTL)]);
    await redis(['SET', STALE_KEY, JSON.stringify(rows)]);   // no TTL — the safety net
  }
  return best;                       // never throws: an empty array just means "nothing to add"
}

export async function fetchToken(ca) {
  try {
    const d = await j(`/tokens/${ca}/pools?page=1`);
    const m = new Map();
    collect(m, d?.data);
    return m.get(ca.toLowerCase()) || null;
  } catch { return null; }
}

export async function fetchByCreator() { return []; }
export const id = 'gecko';