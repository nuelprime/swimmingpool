// CHAIN INDEXER — reads factory creation events from Blockscout, tags each token by launchpad,
// writes to Redis. This is the source of truth for what exists. Launchpad APIs only enrich numbers.
//
// Runs incrementally from cron: each tick reads events newer than the last cursor per factory.
// First run backfills a bounded window so the pool isn't empty.

import { FACTORIES, launchpadOf, TOKEN_PARAMS, LAUNCH_EVENTS } from '../lib/factories.js';
import { tokenIdentity } from '../lib/onchain.js';
import { resolveTags } from '../lib/tagger.js';
import { resolveHolders } from '../lib/holders.js';
import { resolveDevs } from '../lib/devs.js';
import { resolveOrigins } from '../lib/origins.js';

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
// TRANSACTION WALK — for factories that emit nothing.
//
// readFactory() reads event logs, which is right for pons, letscash and the rest. But a growing
// number of deployers on this chain declare no events at all: Stonk Launcher's
// CollectionTokenDeployer has one external function (`deploy`) and emits nothing, and bankr's
// Doppler factory and lemon's TokenDeployer are the same. Log-walking sees zero, so those pads
// stayed invisible until somebody found a private API.
//
// The tokens are still recoverable: list the transactions sent TO the factory, then read each one's
// internal transactions for the contract-creation entry. That also hands over the dev wallet for
// free — it's the tx sender — which the log route often has to guess at.
//
// Costs one extra request per launch, so it's opt-in per factory via `mode: 'tx'` and bounded by
// the same page budget as the log walk.
const readAny = (addr, cfg, stopBlock, maxPages, startParams = null) =>
  (cfg.mode === 'tx' ? readFactoryTxs : readFactory)(addr, cfg, stopBlock, maxPages, startParams);

async function readFactoryTxs(factoryAddr, cfg, stopBlock, maxPages, startParams = null) {
  const tokens = [];
  let params = startParams, pages = 0, newestBlock = stopBlock;
  do {
    const q = params
      ? `?block_number=${params.block_number}&index=${params.index}&items_count=${params.items_count}`
      : '';
    let d;
    try { d = await bs(`/addresses/${factoryAddr}/transactions${q}${q ? '&' : '?'}filter=to`); } catch { break; }
    const items = d.items || [];
    let caughtUp = false;
    for (const t of items) {
      const blk = t.block_number || t.block || 0;
      if (blk > newestBlock) newestBlock = blk;
      if (stopBlock && blk <= stopBlock) { caughtUp = true; break; }
      if (t.status && t.status !== 'ok') continue;
      let itx;
      try { itx = await bs(`/transactions/${t.hash}/internal-transactions`); } catch { continue; }
      for (const x of (itx.items || [])) {
        if (!String(x.type || '').toLowerCase().includes('create')) continue;
        const ca = String((x.created_contract || {}).hash || '').toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(ca)) continue;
        if (tokens.some(k => k.ca === ca)) continue;
        tokens.push({
          ca,
          launchpad: cfg.launchpad,
          deployer: String((t.from || {}).hash || '').toLowerCase() || null,   // the caller is the dev
          pool: null,
          pairToken: null,
          block: blk,
          ts: t.timestamp ? new Date(t.timestamp).getTime() : null,
        });
      }
    }
    params = caughtUp ? null : d.next_page_params;
    pages++;
    if (caughtUp) break;
  } while (params && pages < maxPages);
  return { tokens, newestBlock, nextParams: params };
}

async function readFactory(factoryAddr, cfg, stopBlock, maxPages, startParams = null) {
  const tokens = [];
  let params = startParams, pages = 0, newestBlock = stopBlock;
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
        deployer: String(p.deployer||p.creator||p.owner||p.dev||'').toLowerCase() || null,
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
  return { tokens, newestBlock, nextParams: params };
}

const DEADLINE_MS = 45_000;   // Vercel kills at 60s; leave headroom to finish and respond

export async function runIndexer({ backfillPages = 3, livePages = 2, only = null } = {}) {
  if (!R_URL || !R_TOK) return { error: 'no redis' };
  const startedAt = Date.now();
  const timeLeft = () => DEADLINE_MS - (Date.now() - startedAt);
  const room = (ms) => timeLeft() > ms;

  // TAIL WORKERS, ROTATED AND RUN FIRST. holders, devs and origins used to run after the symbol
  // sweep, and once the letscash backfill pushed the unnamed queue past 12,000 the sweep plus the
  // factory scans consumed the entire 45s budget — so all three were skipped every single tick and
  // origins, being last, never ran once. They read worklists the feed publishes, so they don't
  // depend on anything the later stages compute; the only reason they were down there was order of
  // writing. One runs per tick, round-robin, the same way factories already rotate. The symbol
  // sweep keeps whatever time is left, which is the right trade: its backlog needs ~150 runs
  // either way, while these three are what the page actually shows.
  //
  // They run BEFORE the factory scans, not after. The scans reached 35s on their own once the deep
  // backfill was walking two pads at four pages each, which tripped the room(12_000) guard and
  // returned early — so anything sitting behind that guard was skipped every tick no matter how it
  // was ordered among itself. The scans have their own deadline check and are a multi-hour job;
  // losing a few backfill pages a tick costs nothing, being permanently skipped costs everything.
  try {
    const turn = Number(await redis(['GET', 'idx:tail'])) || 0;
    const worker = ['holders', 'devs', 'origins'][turn % 3];
    const list = async (key) => {
      try { const raw = await redis(['GET', key]); const l = raw ? JSON.parse(raw) : null;
            return Array.isArray(l) && l.length ? l : null; } catch { return null; }
    };
    if (worker === 'holders') {
      const t = await list('need:holders');
      if (t && room(6_000)) summary._holders = await resolveHolders(t, 150);
    } else if (worker === 'devs') {
      const t = await list('need:devs');
      if (t && room(5_000)) summary._devs = await resolveDevs(t, 12);
    } else {
      const t = await list('need:origins');
      // 12, not 40: Blockscout answers about 1.4/sec at four lanes, so 40 would be ~28s of a 45s
      // budget on its own — the batch that never fits is worth less than the batch that always does
      if (t && room(6_000)) summary._origins = await resolveOrigins(t, 12);
    }
    summary._tail = worker;
    await redis(['SET', 'idx:tail', String((turn + 1) % 3)]);
  } catch {}
  const summary = {};
  // rotate one factory per invocation so each run fits the serverless time budget.
  // retired pads keep their existing rows and their labels, but stop consuming scan budget —
  // with letscash and bankr now on their own APIs, that budget belongs to pools.fun.
  const all = Object.entries(FACTORIES).filter(([, cfg]) => !cfg.retired);
  let targets = all;
  if (!only) {
    const turnRaw = await redis(['GET', 'idx:turn']);
    const turn = turnRaw ? parseInt(turnRaw, 10) : 0;
    // Take three factories per run rather than one. With 9 registered, one-per-run meant a pad
    // like letscash only got a turn every ~45 minutes, so its new pairs never surfaced.
    targets = [all[turn % all.length], all[(turn + 1) % all.length], all[(turn + 2) % all.length]];
    await redis(['SET', 'idx:turn', String((turn + 3) % all.length)]);
  } else {
    targets = all.filter(([a, c]) => c.launchpad === only || a === only.toLowerCase());
  }
  for (const [addr, cfg] of targets) {
    const cursorKey = `idx:cursor:${addr}`;
    const lastRaw = await redis(['GET', cursorKey]);
    const last = lastRaw ? parseInt(lastRaw, 10) : 0;
    const pages = last ? livePages : backfillPages; // first run backfills deeper
    let res;
    try { res = await readAny(addr, cfg, last, pages); } catch { summary[cfg.launchpad] = 'err'; continue; }
    // write tokens into the index hash (idx:tokens), keyed by CA
    if (res.tokens.length) {
      // fill on-chain identity for the newest tokens (bounded so cron stays fast)
      const toName = res.tokens.slice(0, 6);
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

    // DEEP BACKFILL, ON ITS OWN CURSOR. The live cursor above only ever looks at the newest two
    // pages. On a factory's first run we read three pages and then jumped the cursor to the newest
    // block, which made every event older than those 150 logs permanently unreachable — letscash
    // has 4,633 factory txs and we were serving 113 of them. This leg walks backward instead,
    // resuming from a saved next_page_params each tick until the factory's history is exhausted.
    const backKey = `idx:back:${addr}`;
    const backRaw = await redis(['GET', backKey]);
    if (backRaw !== 'done' && Date.now() - startedAt < DEADLINE_MS - 12_000) {
      let startParams = null;
      if (backRaw) { try { startParams = JSON.parse(backRaw); } catch {} }
      else startParams = res.nextParams || null;      // seed from where the live leg stopped
      if (startParams) {
        let b;
        try { b = await readAny(addr, cfg, 0, 4, startParams); } catch { b = null; }
        if (b) {
          if (b.tokens.length) {
            const ex = await redis(['HMGET', 'idx:tokens', ...b.tokens.map(t => t.ca)]);
            const hs = ['HSET', 'idx:tokens'];
            b.tokens.forEach((t, i) => {
              const prevRaw = Array.isArray(ex) ? ex[i] : null;
              if (prevRaw) { try { const pv = JSON.parse(prevRaw);
                for (const k of Object.keys(pv)) if (t[k] == null && pv[k] != null) t[k] = pv[k]; } catch {} }
              hs.push(t.ca, JSON.stringify(t));
            });
            await redis(hs);
          }
          await redis(['SET', backKey, b.nextParams ? JSON.stringify(b.nextParams) : 'done']);
          summary[cfg.launchpad + ':back'] = b.tokens.length;
        }
      } else await redis(['SET', backKey, 'done']);
    }
    summary[cfg.launchpad] = res.tokens.length;
  }
  // stamp as soon as the factory read is done — everything after this is optional polish,
  // and we must not lose the record of a successful run if a slow step times out.
  await redis(['SET', 'idx:lastRun', String(Date.now())]);

  // Everything past this point is optional polish — skip it when the clock is short so the
  // function returns cleanly rather than being killed mid-flight.
  if (!room(12_000)) return { ...summary, _skipped: 'identity/tags/holders/devs', _ms: Date.now() - startedAt };


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
    const batch = need.slice(0, 80);   // name/symbol are cheap eth_calls, not Blockscout
                                       // lookups — 12/run left 200-token pads invisible for hours
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

  if (!room(10_000)) return { ...summary, _skipped: 'tags/holders/devs', _ms: Date.now() - startedAt };

  // RETIRE HISTORY. Marking a factory `retired` only stops future scans — its rows stay in
  // idx:tokens and keep being served, so dontblink was still shipping 59 tokens. Delete them once
  // and remember it: HGETALL on the whole index is not something to repeat every five minutes.
  try {
    const retired = new Set(
      Object.values(FACTORIES).filter(c => c.retired).map(c => c.launchpad)
    );
    if (retired.size) {
      const stamp = `idx:retired:${[...retired].sort().join(',')}`;
      const already = await redis(['GET', stamp]);
      if (!already) {
        const rows = await redis(['HGETALL', 'idx:tokens']);
        const kill = [];
        if (Array.isArray(rows)) {
          for (let i = 0; i < rows.length; i += 2) {
            try { if (retired.has(JSON.parse(rows[i + 1]).launchpad)) kill.push(rows[i]); } catch {}
          }
        }
        for (let i = 0; i < kill.length; i += 200) {
          await redis(['HDEL', 'idx:tokens', ...kill.slice(i, i + 200)]);
        }
        await redis(['SET', stamp, String(Date.now())]);
        summary.retired = { pads: [...retired], removed: kill.length };
      }
    }
  } catch {}

  // TAG RESOLUTION — give the launchpad tag cache a push each run using whatever the
  // feed most recently served (seen:v2). One Blockscout call per token, cached forever.
  try {
    const seen = await redis(['HGETALL', 'seen:v2']);
    const cas = [];
    if (Array.isArray(seen)) for (let i = 0; i < seen.length; i += 2) cas.push(seen[i]);
    if (cas.length) {
      const t = await resolveTags(cas, 25);
      summary._tagged = t.resolved;
      if (t.newPads.length) summary._newFactories = t.newPads;
    }
  } catch {}

  return { ...summary, _ms: Date.now() - startedAt };
}

// HTTP entry — called by cron (pulse.yml) or manually
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const only = req.query.only ? String(req.query.only) : null;
  const out = await runIndexer({ backfillPages: 3, livePages: 2, only });
  const total = await redis(['HLEN', 'idx:tokens']);
  return res.status(200).json({ ok: true, ranThisTick: out, indexTotal: total, at: Date.now() });
}