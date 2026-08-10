// GET /api/ohlc?ca=0x…  → { candles:[{t,o,h,l,c,v}], swaps:[…] } for the live chart.
// noxa-only (it's the source that exposes candles). Cached 20s.
import * as noxa from '../lib/adapters/noxa.js';

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
  const key = `ohlc:v1:${ca.toLowerCase()}`;

  const cached = await redis(['GET', key]);
  if (cached) { res.setHeader('X-Cache', 'hit'); return res.status(200).json(JSON.parse(cached)); }

  const [raw, swaps] = await Promise.all([noxa.fetchOhlc(ca), noxa.fetchSwaps(ca)]);
  const candles = (Array.isArray(raw) ? raw : []).map(c => ({
    t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume,
  })).filter(c => c.t && c.c != null);

  const payload = { at: Date.now(), candles, swaps: swaps.map(s => ({ side: s.side, eth: s.ethAmount, price: s.priceEth, ts: s.timestamp })) };
  await redis(['SET', key, JSON.stringify(payload), 'EX', '20']);
  res.setHeader('X-Cache', 'miss');
  return res.status(200).json(payload);
}
