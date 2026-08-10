// CHAIN INDEXER — reads factory creation events from Blockscout, tags each token by launchpad,
// writes to Redis. This is the source of truth for what exists. Launchpad APIs only enrich numbers.
//
// Runs incrementally from cron: each tick reads events newer than the last cursor per factory.
// First run backfills a bounded window so the pool isn't empty.

import { FACTORIES, launchpadOf, TOKEN_PARAMS, LAUNCH_EVENTS } from './factories.js';
import { tokenIdentity } from './onchain.js';
import { resolveTags } from './tagger.js';

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

async function bs(path) {
  const r = await fetch(BS + path, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`bs ${path} ${r.status}`);
  return r.json();
}

function decodeParams(ev) {
  const dec = ev.decoded || {};
  const out = {};
  for (const p of (dec.parameters || [])) out[p.name] = p.value;
  return out;
}

// read one factory's logs, newest first, until we pass `stopBlock` (last-seen) or hit maxPages
async function readFactory(factoryAddr, cfg, stopBlock, maxPages) {
  const tokens = [];
  let params = null, pages = 0, newestBlock = stopBlock;
  do {
    const q = params ? `?block_number=${params.block_number}&index=${params.index}&items_count=${params.items_count}` : '';
    let d;
    try { d = await bs(`/addresses/${factoryAddr}/logs${q}`); } catch { break; }
    const items = d.items || [];
    for (const ev of items) {
      const blk = ev.block_number || 0;
      if (blk > newestBlock) newestBlock = blk;
      if (stopBlock && blk <= stopBlock) { params = null; break; } // caught up
      const p = decodeParams(ev);
      // only launch-type events
      const mc = (ev.decoded || {}).method_call || '';
      if (!LAUNCH_EVENTS.some(n => mc.startsWith(n))) continue;
      let ca = (cfg.tokenParam ? p[cfg.tokenParam] : null) || '';
      if (!ca) { for (const k of TOKEN_PARAMS) { if (p[k]) { ca = p[k]; break; } } }
      ca = String(ca).toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(ca)) continue;
      const rec = {
        ca,
        launchpad: cfg.launchpad,
        deployer: String(p.deployer||'').toLowerCase() || null,
        pool: String(p.pool||'').toLowerCase() || null,
        pairToken: String(p.pairToken||'').toLowerCase() || null,
        block: blk,
        ts: ev.block_timestamp ? new Date(ev.block_timestamp).getTime() : null,
      };
      // pons (and others) emit both TokenLaunched (carries pool/pairToken) and TokenDeployed
      // (does not) for the same token. Merge so a later, thinner event can't wipe the pool.
      const seenIdx = tokens.findIndex(t => t.ca === ca);
      if (seenIdx === -1) tokens.push(rec);
      else {
        const cur = tokens[seenIdx];
        for (const k of ['deployer','pool','pairToken','ts','block']) if (cur[k] == null && rec[k] != null) cur[k] = rec[k];
      }
    }
    params = d.next_page_params;
    pages++;
    if (stopBlock && items.some(e => (e.block_number || 0) <= stopBlock)) break;
  } while (params && pages < maxPages);
  return { tokens, newestBlock };
}

export async function runIndexer({ backfillPages = 3, livePages = 2, only = null } = {}) {
  if (!R_URL || !R_TOK) return { error: 'no redis' };
  const summary = {};
  // rotate one factory per invocation so each run fits the serverless time budget.
  const all = Object.entries(FACTORIES);
  let targets = all;
  if (!only) {
    const turnRaw = await redis(['GET', 'idx:turn']);
    const turn = turnRaw ? parseInt(turnRaw, 10) : 0;
    targets = [all[turn % all.length]];
    await redis(['SET', 'idx:turn', String((turn + 1) % all.length)]);
  } else {
    targets = all.filter(([a, c]) => c.launchpad === only || a === only.toLowerCase());
  }
  for (const [addr, cfg] of targets) {
    const cursorKey = `idx:cursor:${addr}`;
    const lastRaw = await redis(['GET', cursorKey]);
    const last = lastRaw ? parseInt(lastRaw, 10) : 0;
    const pages = last ? livePages : backfillPages; // first run backfills deeper
    let res;
    try { res = await readFactory(addr, cfg, last, pages); } catch { summary[cfg.launchpad] = 'err'; continue; }
    // write tokens into the index hash (idx:tokens), keyed by CA
    if (res.tokens.length) {
      // fill on-chain identity for the newest tokens (bounded so cron stays fast)
      const toName = res.tokens.slice(0, 8);
      await Promise.all(toName.map(async t => {
        const id = await tokenIdentity(t.ca);
        t.name = id.name; t.sym = id.symbol;
      }));
      // merge with existing stored records so we never regress a known pool/pairToken/symbol
      const existing = await redis(['HMGET', 'idx:tokens', ...res.tokens.map(t => t.ca)]);
      const hset = ['HSET', 'idx:tokens'];
      res.tokens.forEach((t, i) => {
        const prevRaw = Array.isArray(existing) ? existing[i] : null;
        if (prevRaw) {
          try {
            const prev = JSON.parse(prevRaw);
            for (const k of Object.keys(prev)) if (t[k] == null && prev[k] != null) t[k] = prev[k];
          } catch {}
        }
        hset.push(t.ca, JSON.stringify(t));
      });
      await redis(hset);
    }
    if (res.newestBlock > last) await redis(['SET', cursorKey, String(res.newestBlock)]);
    summary[cfg.launchpad] = res.tokens.length;
  }
  // PROGRESSIVE IDENTITY BACKFILL — name tokens already in the index that still lack a symbol,
  // so the feed's quality gate lets more of them through each tick instead of them sitting unrenderable.
  try {
    const all = await redis(['HGETALL', 'idx:tokens']);
    const need = [];
    if (Array.isArray(all)) {
      for (let i = 1; i < all.length; i += 2) {
        try { const t = JSON.parse(all[i]); if (!t.sym) need.push(t); } catch {}
      }
    }
    const batch = need.slice(0, 30);
    if (batch.length) {
      await Promise.all(batch.map(async t => {
        const id = await tokenIdentity(t.ca);
        if (id.symbol) { t.sym = id.symbol; t.name = id.name; }
      }));
      const hset = ['HSET', 'idx:tokens'];
      for (const t of batch) if (t.sym) hset.push(t.ca, JSON.stringify(t));
      if (hset.length > 2) await redis(hset);
      summary._named = hset.length > 2 ? (hset.length - 2) / 2 : 0;
      summary._stillUnnamed = need.length - batch.filter(t => t.sym).length;
    }
  } catch {}

  // TAG RESOLUTION — give the launchpad tag cache a push each run using whatever the
  // feed most recently served (seen:v2). One Blockscout call per token, cached forever.
  try {
    const seen = await redis(['HGETALL', 'seen:v2']);
    const cas = [];
    if (Array.isArray(seen)) for (let i = 0; i < seen.length; i += 2) cas.push(seen[i]);
    if (cas.length) {
      const t = await resolveTags(cas, 40);
      summary._tagged = t.resolved;
      if (t.newPads.length) summary._newFactories = t.newPads;
    }
  } catch {}

  // stamp last run
  await redis(['SET', 'idx:lastRun', String(Date.now())]);
  return summary;
}

// HTTP entry — called by cron (pulse.yml) or manually
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const only = req.query.only ? String(req.query.only) : null;
  const out = await runIndexer({ backfillPages: 3, livePages: 2, only });
  const total = await redis(['HLEN', 'idx:tokens']);
  return res.status(200).json({ ok: true, ranThisTick: out, indexTotal: total, at: Date.now() });
}