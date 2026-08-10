// pons adapter. pons has no public data API (their /api/noxa-market route is 410 Gone),
// so this adapter sources tokens from the chain index (factory events) and enriches them
// ON-CHAIN: identity from the token contract, price/liquidity from its pool reserves.
//
// Same quality bar as the API-backed adapters: if a token can't produce a symbol AND
// real numbers, it isn't returned. No blank rows.

import { ethUsd, valid } from './_shape.js';
import { poolPrice, tokenIdentity } from '../onchain.js';

// pons's factory is NOT yet identified (see factories.js). Until it is, this adapter
// returns nothing rather than claiming tokens that belong to another launchpad.
const PONS_FACTORY = null;
const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    return (await r.json()).result;
  } catch { return null; }
}

// read the chain-indexed pons tokens, newest first
async function indexedPons(limit = 60) {
  const all = await redis(['HGETALL', 'idx:tokens']);
  const out = [];
  if (Array.isArray(all)) {
    for (let i = 1; i < all.length; i += 2) {
      try { const t = JSON.parse(all[i]); if (t.launchpad === 'pons') out.push(t); } catch {}
    }
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out.slice(0, limit);
}

// enrich one token fully on-chain; returns null if it can't meet the quality bar
async function enrich(t, px) {
  let sym = t.sym, name = t.name;
  if (!sym) { const id = await tokenIdentity(t.ca); sym = id.symbol; name = id.name; }
  if (!sym) return null;                       // no identity → not displayable

  const p = t.pool ? await poolPrice(t.pool, t.ca) : null;
  const liqUsd = p ? p.liqNative * px : null;
  // mcap needs supply; most launchpad tokens are 1e9 — derive from price when we have it
  const mcapUsd = p ? p.priceNative * px * 1e9 : null;

  // QUALITY BAR: these tokens graduate to Uniswap V4 (singleton PoolManager), so V2-style
  // reserve reads return nothing. Without real numbers we do NOT emit a row — the feed's
  // launchpad tag fix-up covers pons tokens using market data from adapters that have it.
  if (mcapUsd == null && liqUsd == null) return null;

  return {
    ca: t.ca, sym, name: name || sym,
    launchpad: 'pons',
    creator: t.deployer || null,
    x: null, telegram: null, website: null,
    mcapUsd, volUsd: null, liqUsd,
    change24h: null, holders: null,
    createdAt: t.ts || null,
    status: null, imageUrl: null, imageEmoji: null, imageHue: null,
    spark: null, _pool: t.pool || null,
  };
}

export async function fetchFeed() {
  if (!PONS_FACTORY) return [];
  if (!R_URL || !R_TOK) return [];             // no index without Redis
  const px = await ethUsd();
  const raw = await indexedPons(60);
  if (!raw.length) return [];
  // bounded concurrency — these are RPC reads
  const out = [];
  const chunk = 10;
  for (let i = 0; i < raw.length; i += chunk) {
    const part = await Promise.all(raw.slice(i, i + chunk).map(t => enrich(t, px).catch(() => null)));
    for (const r of part) if (r && valid(r)) out.push(r);
  }
  return out;
}

export async function fetchToken(ca) {
  if (!R_URL || !R_TOK) return null;
  const rec = await redis(['HGET', 'idx:tokens', ca.toLowerCase()]);
  if (!rec) return null;
  try {
    const t = JSON.parse(rec);
    if (t.launchpad !== 'pons') return null;
    return await enrich(t, await ethUsd());
  } catch { return null; }
}

export async function fetchByCreator(wallet) {
  if (!R_URL || !R_TOK) return [];
  const all = await redis(['HGETALL', 'idx:tokens']);
  const want = wallet.toLowerCase();
  const out = [];
  if (Array.isArray(all)) {
    for (let i = 1; i < all.length; i += 2) {
      try {
        const t = JSON.parse(all[i]);
        if (t.launchpad === 'pons' && (t.deployer || '').toLowerCase() === want && t.sym) {
          out.push({ ca: t.ca, sym: t.sym, name: t.name, launchpad: 'pons', createdAt: t.ts, mcapUsd: null });
        }
      } catch {}
    }
  }
  return out;
}

export const id = 'pons';
export const factory = PONS_FACTORY;