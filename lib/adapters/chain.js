// CHAIN adapter — discovery straight from the chain, launchpad-agnostic.
//
// Blockscout's /tokens endpoint returns the chain's tokens sorted by market cap. That's the
// only source that sees EVERY launchpad at once, which is how graduated pons tokens (YOLO, HMM)
// and anything from a pad we haven't integrated end up in the feed. Each token is attributed to
// the factory that deployed it, so the launchpad tag is authoritative rather than whoever's API
// happened to list it. Bridged assets and tokenized stocks are excluded by factory.
//
// It also carries icon_url, which fills image gaps (pools.trade ships emoji, not logos).

import { FACTORIES, NON_LAUNCH_FACTORIES, EXCLUDE_TOKENS, EXCLUDE_SYMBOLS, OTHER } from '../factories.js';
import { valid, logoUrl } from './_shape.js';

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

// Is this deployer a contract? Launchpad factories are contracts; bridged/manual tokens
// (USDE, USDG, VIRTUAL, STONKBROKER…) are deployed by EOAs. Cached per factory, not per token.
async function isFactoryContract(f) {
  const key = `isfac:${f}`;
  const hit = await redis(['GET', key]);
  if (hit != null) return hit === '1';
  try {
    const d = await bs(`/addresses/${f}`, 8000);
    const v = d.is_contract === true;
    await redis(['SET', key, v ? '1' : '0']);
    return v;
  } catch { return false; }
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
  const pad = FACTORIES[factory]?.launchpad || OTHER;
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
    imageUrl: logoUrl(t.icon_url),
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
  const pending = [];
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
      if (!f) return;
      if (NON_LAUNCH_FACTORIES.has(f)) return;        // bridged assets, tokenized stocks
      const _ca = (t.address_hash || '').toLowerCase();
      const _sym = (t.symbol || '').toUpperCase();
      if (EXCLUDE_TOKENS.has(_ca) || EXCLUDE_SYMBOLS.has(_sym)) return;  // wrapped native, stables
      pending.push({ t, f });                          // contract-check happens below
    });
  }
  // Gate on "deployer is a contract". A KNOWN factory skips the check; an unknown one is only
  // included if it's a contract — that keeps real launchpads (PONS, TokenPoolFactory…) while
  // excluding EOA-deployed bridged majors. Previously unknown factories were dropped outright,
  // which is why a $31M token like PONS never appeared.
  const uniqUnknown = [...new Set(pending.filter(x => !FACTORIES[x.f]).map(x => x.f))];
  const contractness = new Map();
  for (let i = 0; i < uniqUnknown.length; i += 6) {
    const slice = uniqUnknown.slice(i, i + 6);
    const res = await Promise.all(slice.map(f => isFactoryContract(f).catch(() => false)));
    slice.forEach((f, k) => contractness.set(f, res[k]));
  }
  for (const { t, f } of pending) {
    if (!FACTORIES[f] && !contractness.get(f)) continue;
    const r = norm(t, f);
    if (r && valid(r)) out.push(r);
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
