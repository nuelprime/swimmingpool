// GET /api/feed → ADAPTERS ARE THE SOURCE OF TRUTH. One adapter per launchpad ("hood"),
// each returning real, displayable rows from the source that curates them best.
// The chain index is used ONLY for two things it's genuinely good at:
//   1. accurate per-creator launch totals (the xN badge)
//   2. verifying/attributing which launchpad a token actually came from
// It never injects blank rows into the feed. Quality first, coverage second.

import * as pools from '../lib/adapters/pools.js';
import * as noxa from '../lib/adapters/noxa.js';
import * as pons from '../lib/adapters/pons.js';
import * as chain from '../lib/adapters/chain.js';
import * as gecko from '../lib/adapters/gecko.js';
import { valid } from '../lib/adapters/_shape.js';
import { LAUNCHPADS } from '../lib/factories.js';
import { cachedTags } from '../lib/tagger.js';
import { enrich as dexEnrich } from '../lib/dex.js';
import { cachedHolders, cachedIcons } from '../lib/holders.js';

// order matters: first adapter to claim a CA owns its launchpad tag
// gecko first: one API covering every pool on the chain with accurate market cap, volume,
// liquidity, 24h change, real pool-creation timestamps and 1h buyer counts. The launchpad
// adapters follow to supply what it lacks — holders, emoji art, X handles — and factory
// attribution below assigns the authoritative launchpad tag.
// pons + chain are retired from the feed: gecko already covers their tokens with better data.
// pools.trade stays for holders/emoji/X handles, noxa for its logos.
const ADAPTERS = [gecko, pools, noxa];
const TTL = 30;

const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    return (await r.json()).result;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');

  const cached = await redis(['GET', 'feed:v4']);
  if (cached) { res.setHeader('X-Cache', 'hit'); return res.status(200).json(JSON.parse(cached)); }

  // 1) every hood's adapter, in parallel — one failing never sinks the feed
  const results = await Promise.allSettled(ADAPTERS.map(a => a.fetchFeed()));
  const merged = new Map();
  const sources = {};
  results.forEach((s, i) => {
    const name = ADAPTERS[i].id;
    sources[name] = s.status === 'fulfilled' ? (s.value?.length || 0) : 'err';
    if (s.status !== 'fulfilled') return;
    for (const row of s.value) {
      if (!valid(row) || !row.sym) continue;              // adapters already guarantee this; belt+braces
      const k = row.ca.toLowerCase();
      const prev = merged.get(k);
      if (!prev) { merged.set(k, row); continue; }
      // first adapter keeps the launchpad tag; later ones only fill genuine gaps
      for (const f of ['mcapUsd','volUsd','liqUsd','change24h','holders','imageUrl','imageEmoji','imageHue','x','telegram','website','createdAt','name','status']) {
        if ((prev[f] === null || prev[f] === undefined) && row[f] != null) prev[f] = row[f];
      }
      if (!prev.alsoOn?.includes(row.launchpad)) (prev.alsoOn ||= []).push(row.launchpad);
    }
  });

  const launches = [...merged.values()];
  const degraded = results.some(s => s.status === 'rejected');

  // 2) AUTHORITATIVE LAUNCHPAD TAG — the factory that deployed the contract, from the
  // tag cache (resolved once per token, cached forever). Adapters over-claim because
  // noxa/pools index the whole chain; only the factory is truth.
  let creatorCounts = {};
  if (R_URL && R_TOK) {
    // PRIMARY tag source: the chain index, built from factory logs (~50 tokens per request —
    // vastly cheaper than per-token lookups, which Blockscout rate-limits).
    const idxTags = new Map();
    const idxRows = await redis(['HGETALL', 'idx:tokens']);
    if (Array.isArray(idxRows)) {
      for (let i = 1; i < idxRows.length; i += 2) {
        try { const t = JSON.parse(idxRows[i]); if (t.launchpad) idxTags.set(t.ca, t.launchpad); } catch {}
      }
    }
    // FALLBACK: per-token factory cache, for anything the index hasn't reached yet.
    const tags = await cachedTags(launches.map(l => l.ca));
    for (const l of launches) {
      const real = idxTags.get(l.ca.toLowerCase()) || tags.get(l.ca.toLowerCase());
      if (real && real !== l.launchpad) {
        if (!l.alsoOn?.includes(l.launchpad)) (l.alsoOn ||= []).push(l.launchpad);
        l.launchpad = real;
      } else if (!real) {
        l.padUnverified = true;              // tag cache hasn't reached it yet
        if (!l.launchpad) l.launchpad = 'other';
      }
    }
    // true creator counts from the same index rows
    if (Array.isArray(idxRows)) {
      for (let i = 1; i < idxRows.length; i += 2) {
        try {
          const t = JSON.parse(idxRows[i]);
          const d = (t.deployer || '').toLowerCase();
          if (d) creatorCounts[d] = (creatorCounts[d] || 0) + 1;
        } catch {}
      }
    }
    // supplement counts with adapter-known creators so xN isn't blank pre-backfill
    for (const l of launches) {
      const c = (l.creator || '').toLowerCase();
      if (c && !creatorCounts[c]) {
        creatorCounts[c] = launches.filter(x => (x.creator || '').toLowerCase() === c).length;
      }
    }
  }

  // 2.5) DEXSCREENER FILL — universal market data. Each launchpad's API leaves different
  // holes (pons has no volume, noxa has no 24h change); dexscreener indexes every pool on the
  // chain, so one pass fills them all consistently.
  try {
    const dex = await dexEnrich(launches.map(l => l.ca), { max: 600 });
    for (const l of launches) {
      const d = dex.get(l.ca.toLowerCase());
      if (!d) continue;
      // dexscreener reads live pool state, so it OVERRIDES rather than merely fills. Blockscout's
      // circulating_market_cap goes stale (it reported arena's BOYZ at $1.56M vs an actual $350K).
      if (d.volUsd != null) l.volUsd = d.volUsd;
      if (d.liqUsd != null) l.liqUsd = d.liqUsd;
      if (d.change24h != null) l.change24h = d.change24h;
      if (d.mcapUsd != null) l.mcapUsd = d.mcapUsd;
      else if (l._fromChain) l.mcapUsd = l.mcapUsd;   // no dex pool → keep chain value as-is
      // media + socials: pools.trade ships emoji rather than logos, pons/noxa lists have no X
      if (!l.imageUrl && d.imageUrl) l.imageUrl = d.imageUrl;
      if (!l.x && d.x) { const m = String(d.x).match(/(?:x|twitter)\.com\/(@?[A-Za-z0-9_]{1,15})/i); if (m) l.x = m[1].replace('@',''); }
      if (!l.telegram && d.telegram) l.telegram = d.telegram;
      if (!l.website && d.website) l.website = d.website;
      l.dexed = true;
    }
  } catch {}

  // 2.6) HOLDERS — only pools.trade exposes them; Blockscout covers every pad. Cache-only read
  // here so the feed never waits on network; the indexer fills the cache in the background.
  try {
    const hold = await cachedHolders(launches.map(l => l.ca));
    // icons from the same cache — fills pools.trade's missing logos
    const icons = await cachedIcons(launches.map(l => l.ca));
    for (const l of launches) { if (!l.imageUrl) { const u = icons.get(l.ca.toLowerCase()); if (u) l.imageUrl = u; } }

    const stillMissing = [];
    for (const l of launches) {
      if (l.holders == null) {
        const h = hold.get(l.ca.toLowerCase());
        if (h != null) l.holders = h; else stillMissing.push(l.ca.toLowerCase());
      }
    }
    // hand the indexer a targeted worklist — otherwise it wastes its budget re-resolving
    // tokens that already report holders via pools.trade
    if (stillMissing.length) {
      // interleave by launchpad — a flat list always starts at the same pad, so the others
      // (pons especially) would never get their turn.
      const byPadQ = new Map();
      for (const l of launches) {
        if (l.holders != null) continue;
        const k = l.launchpad || 'unknown';
        if (!byPadQ.has(k)) byPadQ.set(k, []);
        byPadQ.get(k).push(l.ca.toLowerCase());
      }
      const queues = [...byPadQ.values()];
      const fair = [];
      for (let i = 0; fair.length < 400 && queues.some(q => q.length); i++) {
        for (const q of queues) { if (q.length) fair.push(q.shift()); }
      }
      await redis(['SET', 'need:holders', JSON.stringify(fair), 'EX', '3600']);
    }
  } catch {}

  const byPad = {};
  for (const l of launches) byPad[l.launchpad || 'unknown'] = (byPad[l.launchpad || 'unknown'] || 0) + 1;

  // 3) ENS for creators (memoized 30d)
  if (R_URL && R_TOK && launches.length) {
    const creators = [...new Set(launches.map(l => (l.creator || '').toLowerCase()).filter(Boolean))];
    if (creators.length) {
      const memo = await redis(['MGET', ...creators.map(c => `ens:v1:${c}`)]);
      const ens = new Map(); const unknown = [];
      creators.forEach((c, i) => { const hit = Array.isArray(memo) ? memo[i] : null; if (hit != null) { if (hit) ens.set(c, hit); } else unknown.push(c); });
      await Promise.all(unknown.slice(0, 15).map(async c => {
        try {
          const r = await fetch(`https://api.ensideas.com/ens/resolve/${c}`, { signal: AbortSignal.timeout(4000) });
          const name = (await r.json())?.name || '';
          if (name) ens.set(c, String(name));
          await redis(['SET', `ens:v1:${c}`, name, 'EX', String(30 * 86400)]);
        } catch {}
      }));
      for (const l of launches) { const n = ens.get((l.creator || '').toLowerCase()); if (n) l.creatorEns = n; }
    }
  }

  // 4) socials map for the X-handle cross-reference
  if (R_URL && R_TOK && launches.length) {
    const hset = ['HSET', 'seen:v2'];
    for (const l of launches) {
      if (!l.x && !l.creator) continue;
      hset.push(l.ca.toLowerCase(), JSON.stringify({ ca: l.ca, sym: l.sym, name: l.name, creator: l.creator, x: l.x, pad: l.launchpad, at: l.createdAt }));
    }
    if (hset.length > 2) await redis(hset);
  }

  const lastRun = await redis(['GET', 'idx:lastRun']);
  const payload = {
    at: Date.now(),
    launches,
    byPad,
    indexerLastRun: lastRun ? parseInt(lastRun, 10) : null,
    sources,
    creatorCounts: Object.keys(creatorCounts).length ? creatorCounts : null,
    launchpads: LAUNCHPADS,
    degraded,
  };

  await redis(['SET', 'feed:v4', JSON.stringify(payload), 'EX', String(TTL)]);
  res.setHeader('X-Cache', 'miss');
  return res.status(200).json(payload);
}