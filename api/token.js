// GET /api/token?ca=0x…&pad=noxa  → token detail + creator rap sheet (wallet + X cross-ref).
// Routes to the launchpad adapter that owns the token (pad hint from the row; falls back to trying both).
import * as pools from './adapters/pools.js';
import * as noxa from './adapters/noxa.js';
import { xHandle } from './adapters/_shape.js';

const ADAPTERS = { 'pools.trade': pools, 'noxa': noxa };
const TTL = 120;
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
  const ca = String(req.query.ca || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) return res.status(400).json({ error: 'bad ca' });
  const pad = String(req.query.pad || '');
  const key = `tok:v2:${ca.toLowerCase()}`;

  const cached = await redis(['GET', key]);
  if (cached) { res.setHeader('X-Cache', 'hit'); return res.status(200).json(JSON.parse(cached)); }

  // resolve launch via the owning adapter (hint first, then whichever answers)
  let launch = null;
  const order = pad && ADAPTERS[pad] ? [ADAPTERS[pad], ...Object.values(ADAPTERS).filter(a => a !== ADAPTERS[pad])] : Object.values(ADAPTERS);
  for (const a of order) { try { const l = await a.fetchToken(ca); if (l?.ca) { launch = l; break; } } catch {} }
  if (!launch) return res.status(404).json({ error: 'not indexed' });

  // backfill creator/x from seen-index (list rows carry it; detail sometimes doesn't)
  if (!launch.creator || !launch.x) {
    const seen = await redis(['HGET', 'seen:v2', ca.toLowerCase()]);
    if (seen) { try { const c = JSON.parse(seen); launch.creator ||= c.creator; launch.x ||= c.x; } catch {} }
    const qc = String(req.query.creator || ''); if (!launch.creator && /^0x[0-9a-fA-F]{40}$/.test(qc)) launch.creator = qc;
    const qx = String(req.query.x || '').replace(/^@/, ''); if (!launch.x && /^[A-Za-z0-9_]{1,15}$/.test(qx)) launch.x = qx;
  }

  // rap sheet — wallet history (owning adapter) + same-X across wallets (seen-index)
  let byWallet = [];
  if (launch.creator) { for (const a of Object.values(ADAPTERS)) { try { const r = await a.fetchByCreator(launch.creator); if (r.length) byWallet.push(...r); } catch {} } }
  byWallet = byWallet.filter(r => r.ca?.toLowerCase() !== ca.toLowerCase());

  let byX = [], otherWallets = [];
  const handle = launch.x ? String(launch.x).toLowerCase() : null;
  if (handle) {
    const all = await redis(['HGETALL', 'seen:v2']);
    if (Array.isArray(all)) {
      for (let i = 1; i < all.length; i += 2) {
        try { const c = JSON.parse(all[i]); if ((c.x || '').toLowerCase() === handle && c.ca.toLowerCase() !== ca.toLowerCase()) byX.push(c); } catch {}
      }
    }
    otherWallets = [...new Set(byX.map(c => c.creator).filter(Boolean))].filter(w => w.toLowerCase() !== (launch.creator || '').toLowerCase());
  }

  const payload = { at: Date.now(), launch, creator: { byWallet, byX, xHandle: handle, otherWallets } };
  await redis(['SET', key, JSON.stringify(payload), 'EX', String(TTL)]);
  res.setHeader('X-Cache', 'miss');
  return res.status(200).json(payload);
}
