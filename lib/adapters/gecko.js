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

export async function fetchFeed({ topPages = 6, newPages = 3 } = {}) {
  const out = new Map();
  const jobs = [];
  for (let i = 1; i <= topPages; i++) jobs.push(j(`/pools?page=${i}&sort=h24_volume_usd_desc`));
  for (let i = 1; i <= newPages; i++) jobs.push(j(`/new_pools?page=${i}`));
  const res = await Promise.allSettled(jobs);
  for (const s of res) if (s.status === 'fulfilled') collect(out, s.value?.data);
  if (!out.size) throw new Error('gecko: empty');
  return [...out.values()];
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