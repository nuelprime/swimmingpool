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
    _dex: p.relationships?.dex?.data?.id || null,   // launchpad hint — see DEX_PAD
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
// With the 90s cache in place these pages cost ~26 calls per 90 seconds (~17/min), comfortably
// under the ~30/min ceiling — so we can see much deeper than the old top-200-by-volume window.
// That window is why mid-tier tokens (decent mcap, modest volume, not brand new) were invisible.
export async function fetchFeed({ topPages = 10, newPages = 10 } = {}) {
  const cached = await redis(['GET', CACHE_KEY]);
  if (cached) { try { return JSON.parse(cached); } catch {} }

  // THUNDERING-HERD GUARD. Without this, several visitors arriving on a cold cache would each
  // launch a full page sweep at once — the very burst that trips the rate limit.
  const lockable = !!(R_URL && R_TOK);
  const gotLock = lockable ? await redis(['SET', LOCK_KEY, '1', 'NX', 'EX', '25']) : 'OK';
  if (lockable && !gotLock) {
    const stale = await redis(['GET', STALE_KEY]);
    if (stale) { try { return JSON.parse(stale); } catch {} }
    return [];
  }

  const out = new Map();
  const paths = [];
  // HARD CEILING OF 10. The free tier rejects page 11+ outright with a 401 ("exceeds the allowed
  // max number for page (10)"). Asking for 20 top pages fetched no extra tokens — it fired ten
  // guaranteed failures per sweep, burned the budget the first ten pages needed, and made every
  // sweep look degraded, which is what froze the cache. See the recovery logic below.
  const cap = (n) => Math.min(n, 10);
  for (let i = 1; i <= cap(topPages); i++) paths.push(`/pools?page=${i}&sort=h24_volume_usd_desc`);
  for (let i = 1; i <= cap(newPages); i++) paths.push(`/new_pools?page=${i}`);

  // THROTTLED CONCURRENCY. One request returns 200 happily, a dozen at once trips instant
  // throttling — "30 calls/minute" is not "30 calls at the same moment".
  let ok = 0;
  const BATCH = 3, GAP_MS = 900;
  for (let i = 0; i < paths.length; i += BATCH) {
    const res = await Promise.allSettled(paths.slice(i, i + BATCH).map(j));
    for (const s of res) if (s.status === 'fulfilled') { ok++; collect(out, s.value?.data); }
    if (i + BATCH < paths.length) await new Promise(r => setTimeout(r, GAP_MS));
  }

  const rows = [...out.values()];
  const health = paths.length ? ok / paths.length : 0;

  // DEGRADATION BY COMPLETENESS, NOT BY SIZE. The old check kept the stale set whenever it was
  // 1.25x bigger than the fresh one. Since ten of twenty-six pages could never succeed, the fresh
  // set was always smaller, so stale won every time and was never rewritten — the feed served a
  // snapshot frozen 42 hours in the past while other pads arrived seconds old. Judge by how many
  // pages actually answered, and never let a snapshot outlive MAX_STALE_MS.
  const MAX_STALE_MS = 20 * 60 * 1000;
  const degraded = health < 0.6;
  const staleRaw = await redis(['GET', STALE_KEY]);
  const staleAt = Number(await redis(['GET', STALE_KEY + ':at'])) || 0;
  let best = rows;
  if (degraded && staleRaw && Date.now() - staleAt < MAX_STALE_MS) {
    try {
      const prev = JSON.parse(staleRaw);
      if (Array.isArray(prev) && prev.length > rows.length) best = prev;
    } catch {}
  }

  // Promote on a healthy sweep, and cache whatever we serve either way — the old code only wrote
  // CACHE_KEY on a healthy sweep, so a degraded run meant every request re-swept every page,
  // which is what kept the rate limit tripped.
  if (rows.length && !degraded) {
    await redis(['SET', STALE_KEY, JSON.stringify(rows)]);
    await redis(['SET', STALE_KEY + ':at', String(Date.now())]);
  }
  if (best.length) await redis(['SET', CACHE_KEY, JSON.stringify(best), 'EX', String(CACHE_TTL)]);
  return best;                       // never throws: an empty array just means "nothing to add"
}

export async function fetchToken(ca) {
  const want = ca.toLowerCase();
  try {
    const d = await j(`/tokens/${ca}/pools?page=1`);
    const m = new Map();
    collect(m, d?.data);
    const hit = m.get(want);
    if (hit) return hit;

    // QUOTE-SIDE FALLBACK. collect() only indexes the base token of a pool, so a token paired
    // as the quote side — which is what happens with RWA/stock pairings like "NVDA / TOKEN" —
    // is invisible to it. Rebuild the row from the quote perspective: price and depth are
    // available; market cap is not, because GT reports fdv/mcap for the base token only.
    for (const p of (d?.data || [])) {
      const a = p.attributes || {};
      const qId = p.relationships?.quote_token?.data?.id || '';
      const qCa = qId.includes('_') ? qId.split('_').pop() : null;
      if (!qCa || qCa.toLowerCase() !== want) continue;
      const nm = String(a.name || '');
      const sym = (nm.split('/')[1] || '').trim().split(' ')[0] || null;
      if (!sym) continue;
      return {
        ca, sym, name: sym,
        launchpad: null, creator: null,
        x: null, telegram: null, website: null,
        mcapUsd: null,                                  // GT reports mcap for the base side only
        volUsd: Number(a.volume_usd?.h24) || null,
        liqUsd: Number(a.reserve_in_usd) || null,
        change24h: null, holders: null, buyers1h: null,
        createdAt: a.pool_created_at ? new Date(a.pool_created_at).getTime() : null,
        status: null, imageUrl: null, imageEmoji: null, imageHue: null, spark: null,
        priceUsd: Number(a.quote_token_price_usd) || null,
        _pool: a.address || null, _quoteSide: true,
      };
    }
    return null;
  } catch { return null; }
}

export async function fetchByCreator() { return []; }
export const id = 'gecko';