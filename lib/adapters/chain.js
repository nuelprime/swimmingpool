// CHAIN adapter — discovery straight from the chain, launchpad-agnostic.
//
// Blockscout's /tokens endpoint returns the chain's tokens sorted by market cap. That's the
// only source that sees EVERY launchpad at once, which is how graduated pons tokens (YOLO, HMM)
// and anything from a pad we haven't integrated end up in the feed. Each token is attributed to
// the factory that deployed it, so the launchpad tag is authoritative rather than whoever's API
// happened to list it. Bridged assets and tokenized stocks are excluded by factory.
//
// It also carries icon_url, which fills image gaps (pools.trade ships emoji, not logos).

import { FACTORIES, NON_LAUNCH_FACTORIES } from '../factories.js';
import { valid } from './_shape.js';

const BS = 'https://robinhoodchain.blockscout.com/api/v2';
const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    return (await r.json()).result;
  } catch { return null; }
}
async function bs(path, timeout = 9000) {
  const r = await fetch(BS + path, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// factory for one token, cached forever (a deployer never changes)
async function factoryOf(ca) {
  const key = `fac:${ca.toLowerCase()}`;
  const hit = await redis(['GET', key]);
  if (hit) return hit;
  try {
    const a = await bs(`/addresses/${ca}`, 8000);
    const f = (a.creator_address_hash || '').toLowerCase();
    if (f) { await redis(['SET', key, f]); return f; }
  } catch {}
  return null;
}

function norm(t, factory) {
  const ca = t.address_hash;
  if (!ca || !t.symbol) return null;
  const pad = FACTORIES[factory]?.launchpad || (factory ? `pad:${factory.slice(0, 8)}` : null);
  const mc = t.circulating_market_cap != null ? Number(t.circulating_market_cap) : null;
  return {
    ca,
    sym: t.symbol,
    name: t.name || t.symbol,
    launchpad: pad,
    creator: null,                                   // deployer EOA isn't in this payload
    x: null, telegram: null, website: null,
    mcapUsd: Number.isFinite(mc) ? mc : null,
    volUsd: t.volume_24h != null ? Number(t.volume_24h) : null,
    liqUsd: null,
    change24h: null,
    holders: t.holders_count != null ? Number(t.holders_count) : null,
    buyers1h: null,
    createdAt: null,
    status: null,
    imageUrl: (t.icon_url && /^https:/.test(t.icon_url)) ? t.icon_url : null,
    imageEmoji: null, imageHue: null, spark: null,
    _fromChain: true,
  };
}

export async function fetchFeed({ resolveBudget = 12 } = {}) {
  let items = [];
  try { items = (await bs('/tokens?type=ERC-20')).items || []; } catch { return []; }
  if (!items.length) return [];

  // Read cached factories in one shot; only spend network on a bounded number of unknowns per
  // call so a cold cache can't stall the feed. The indexer warms the rest in the background.
  const cas = items.map(t => t.address_hash).filter(Boolean);
  const cached = new Map();
  if (R_URL && R_TOK && cas.length) {
    const vals = await redis(['MGET', ...cas.map(c => `fac:${c.toLowerCase()}`)]);
    if (Array.isArray(vals)) vals.forEach((v, i) => { if (v) cached.set(cas[i].toLowerCase(), v); });
  }
  let budget = resolveBudget;

  const out = [];
  const chunk = 10;
  for (let i = 0; i < items.length; i += chunk) {
    const slice = items.slice(i, i + chunk);
    const facs = await Promise.all(slice.map(async t => {
      const hit = cached.get((t.address_hash || '').toLowerCase());
      if (hit) return hit;
      if (budget-- <= 0) return null;                 // leave the rest for the next run
      return factoryOf(t.address_hash).catch(() => null);
    }));
    slice.forEach((t, k) => {
      const f = facs[k];
      if (!f) return;                                // direct deploy / unknown → skip
      if (NON_LAUNCH_FACTORIES.has(f)) return;        // bridged assets, tokenized stocks
      if (!FACTORIES[f]) return;                      // unknown pad → surfaced via /api/discover, not the feed
      const r = norm(t, f);
      if (r && valid(r)) out.push(r);
    });
  }
  return out;
}

// per-token lookup: also useful as an image/holders source for any CA
export async function fetchToken(ca) {
  try {
    const t = await bs(`/tokens/${ca}`);
    if (!t?.symbol) return null;
    const f = await factoryOf(ca);
    if (!f || NON_LAUNCH_FACTORIES.has(f) || !FACTORIES[f]) return null;
    return norm({ ...t, address_hash: ca }, f);
  } catch { return null; }
}

export async function fetchByCreator() { return []; }
export const id = 'chain';