// pons adapter. pons has no public data API, so this reads everything from the chain:
// tokens + pool + pairToken come from the factory event (chain index), and market data
// comes from the pool itself via the on-chain reader.
//
// Same quality bar as API-backed adapters: no symbol or no real numbers → no row.

import { ethUsd, valid } from './_shape.js';
import { marketData, tokenIdentity } from '../onchain.js';

export const PONS_FACTORY = '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb';

const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    return (await r.json()).result;
  } catch { return null; }
}

async function indexedPons(limit = 150) {
  const all = await redis(['HGETALL', 'idx:tokens']);
  const out = [];
  if (Array.isArray(all)) {
    for (let i = 1; i < all.length; i += 2) {
      try { const t = JSON.parse(all[i]); if (t.launchpad === 'pons' && t.pool) out.push(t); } catch {}
    }
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out.slice(0, limit);
}

async function toRow(t, px) {
  let sym = t.sym, name = t.name;
  if (!sym) { const id = await tokenIdentity(t.ca); sym = id.symbol; name = id.name; }
  if (!sym) return null;

  const md = await marketData({ token: t.ca, pool: t.pool, pairToken: t.pairToken }, px);
  if (!md) return null;                       // no real market → no row

  return {
    ca: t.ca, sym, name: name || sym,
    launchpad: 'pons',
    creator: t.deployer || null,
    x: null, telegram: null, website: null,
    mcapUsd: md.mcapUsd, volUsd: null, liqUsd: md.liqUsd,
    change24h: null, holders: null, buyers1h: null,
    createdAt: t.ts || null,
    status: null, imageUrl: null, imageEmoji: null, imageHue: null,
    spark: null, _pool: t.pool,
  };
}

export async function fetchFeed() {
  if (!R_URL || !R_TOK) return [];
  const px = await ethUsd();
  const raw = await indexedPons(150);
  if (!raw.length) return [];
  const out = [];
  const chunk = 12;                            // bounded — these are RPC reads
  for (let i = 0; i < raw.length; i += chunk) {
    const part = await Promise.all(raw.slice(i, i + chunk).map(t => toRow(t, px).catch(() => null)));
    for (const r of part) if (r && valid(r)) out.push(r);
  }
  // rank by market cap — the index gives us newest-first, which on a pad doing thousands of
  // launches a day is mostly bot spam. Surface the biggest of what we can actually see.
  out.sort((a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0));
  return out;
}

export async function fetchToken(ca) {
  if (!R_URL || !R_TOK) return null;
  const rec = await redis(['HGET', 'idx:tokens', ca.toLowerCase()]);
  if (!rec) return null;
  try {
    const t = JSON.parse(rec);
    if (t.launchpad !== 'pons') return null;
    return await toRow(t, await ethUsd());
  } catch { return null; }
}

export async function fetchByCreator(wallet) {
  return byCreatorFromIndex(wallet, 'pons');
}

// shared: pull a wallet's launches for one launchpad out of the chain index
export async function byCreatorFromIndex(wallet, launchpad) {
  if (!R_URL || !R_TOK) return [];
  const all = await redis(['HGETALL', 'idx:tokens']);
  const want = wallet.toLowerCase();
  const out = [];
  if (Array.isArray(all)) {
    for (let i = 1; i < all.length; i += 2) {
      try {
        const t = JSON.parse(all[i]);
        if ((!launchpad || t.launchpad === launchpad) && (t.deployer || '').toLowerCase() === want && t.sym) {
          out.push({ ca: t.ca, sym: t.sym, name: t.name, launchpad: t.launchpad, createdAt: t.ts, mcapUsd: null });
        }
      } catch {}
    }
  }
  return out;
}

export const id = 'pons';