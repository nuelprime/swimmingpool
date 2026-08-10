// GET /api/feed → ADAPTERS ARE THE SOURCE OF TRUTH. One adapter per launchpad ("hood"),
// each returning real, displayable rows from the source that curates them best.
// The chain index is used ONLY for two things it's genuinely good at:
//   1. accurate per-creator launch totals (the xN badge)
//   2. verifying/attributing which launchpad a token actually came from
// It never injects blank rows into the feed. Quality first, coverage second.

import * as pools from './adapters/pools.js';
import * as noxa from './adapters/noxa.js';
import * as pons from './adapters/pons.js';
import { valid } from './adapters/_shape.js';
import { LAUNCHPADS } from './factories.js';
import { cachedTags } from './tagger.js';

// order matters: first adapter to claim a CA owns its launchpad tag
const ADAPTERS = [pools, noxa, pons];
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
    const tags = await cachedTags(launches.map(l => l.ca));
    for (const l of launches) {
      const real = tags.get(l.ca.toLowerCase());
      if (real && real !== l.launchpad) {
        if (!l.alsoOn?.includes(l.launchpad)) (l.alsoOn ||= []).push(l.launchpad);
        l.launchpad = real;
      } else if (!real) {
        l.padUnverified = true;   // not resolved yet; adapter's guess stands
      }
    }
    // true creator counts from the chain index
    const idxRaw = await redis(['HGETALL', 'idx:tokens']);
    if (Array.isArray(idxRaw)) {
      for (let i = 1; i < idxRaw.length; i += 2) {
        try {
          const t = JSON.parse(idxRaw[i]);
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

  const payload = {
    at: Date.now(),
    launches,
    byPad,
    sources,
    creatorCounts: Object.keys(creatorCounts).length ? creatorCounts : null,
    launchpads: LAUNCHPADS,
    degraded,
  };

  await redis(['SET', 'feed:v4', JSON.stringify(payload), 'EX', String(TTL)]);
  res.setHeader('X-Cache', 'miss');
  return res.status(200).json(payload);
}