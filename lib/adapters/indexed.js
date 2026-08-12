// INDEXED adapter — serves tokens the indexer discovered by reading each registered factory's
// event log (idx:tokens in Redis).
//
// Why this exists: gecko only returns a top-by-volume window, and the launchpad APIs only know
// their own tokens — and only pools.trade/noxa/pons even have one. So a token like letscash's
// INTERN ($1.15M mcap, 1,184 holders) was invisible: correct factory, correctly registered,
// but nothing in the feed enumerated tokens BY factory. The indexer already does exactly that;
// this adapter simply lets its output reach the feed.
//
// It emits no market numbers of its own — dexscreener/gecko enrichment in feed.js fills those,
// and the quality gate drops anything that still has nothing to show.

import { FACTORIES } from '../factories.js';

const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    return (await r.json()).result;
  } catch { return null; }
}

// Which pads already have a dedicated API adapter? Their tokens arrive with richer data there,
// so we only surface index rows for the pads that have no other route into the feed.
const COVERED = new Set(['pools.trade', 'noxa', 'pons', 'letscash']);

export async function fetchFeed({ perPad = 220, limit = 900 } = {}) {
  if (!R_URL || !R_TOK) return [];
  const all = await redis(['HGETALL', 'idx:tokens']);
  if (!Array.isArray(all)) return [];

  const rows = [];
  for (let i = 1; i < all.length; i += 2) {
    try {
      const t = JSON.parse(all[i]);
      if (!t.ca || !t.sym) continue;                 // no identity → not displayable
      if (!t.launchpad || COVERED.has(t.launchpad)) continue;
      rows.push({
        ca: t.ca,
        sym: t.sym,
        name: t.name || t.sym,
        launchpad: t.launchpad,
        creator: t.deployer || null,
        x: null, telegram: null, website: null,
        mcapUsd: null, volUsd: null, liqUsd: null,   // enrichment supplies these
        change24h: null, holders: null, buyers1h: null,
        createdAt: t.ts || null,
        status: null, imageUrl: null, imageEmoji: null, imageHue: null, spark: null,
        _pool: t.pool || null, _fromIndex: true,
      });
    } catch {}
  }
  // PER-PAD QUOTAS. This used to be one newest-first slice of 220 shared by every pad without an
  // API — letscash, pools.fun, dontblink and anything registered later. Two consequences, both
  // bad: the pads competed for the same slots, so improving letscash coverage actively evicted
  // pools.fun rows; and because the slice was newest-first, backfilled history could never
  // surface no matter how deep the indexer walked. Give each pad its own allowance instead.
  const byPad = new Map();
  for (const r of rows) {
    const k = r.launchpad;
    if (!byPad.has(k)) byPad.set(k, []);
    byPad.get(k).push(r);
  }
  const out = [];
  for (const list of byPad.values()) {
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    out.push(...list.slice(0, perPad));
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out.slice(0, limit);
}

export async function fetchToken(ca) {
  if (!R_URL || !R_TOK) return null;
  const rec = await redis(['HGET', 'idx:tokens', ca.toLowerCase()]);
  if (!rec) return null;
  try {
    const t = JSON.parse(rec);
    if (!t.sym) return null;
    return {
      ca: t.ca, sym: t.sym, name: t.name || t.sym, launchpad: t.launchpad || null,
      creator: t.deployer || null, x: null, telegram: null, website: null,
      mcapUsd: null, volUsd: null, liqUsd: null, change24h: null, holders: null, buyers1h: null,
      createdAt: t.ts || null, status: null, imageUrl: null, imageEmoji: null, imageHue: null,
      spark: null, _pool: t.pool || null, _fromIndex: true,
    };
  } catch { return null; }
}

export async function fetchByCreator() { return []; }
export const id = 'indexed';