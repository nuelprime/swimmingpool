// Canonical token row every launchpad adapter must return.
// Keeping one shape means feed.js / token.js / the frontend never learn a launchpad's quirks.
//
// {
//   ca, sym, name, launchpad,           // identity + origin
//   creator, x, telegram, website,      // socials / dev
//   mcapUsd, volUsd, liqUsd,            // money (USD-normalized)
//   change24h, holders, createdAt,      // stats (createdAt = ms epoch)
//   status, imageUrl, spark,            // misc
// }
//
// Any field an adapter can't fill → null. Never throw from a mapper; return null and let feed.js drop it.

export const ETH_USD_FALLBACK = 3500; // used only if live price fetch fails

let _ethUsd = null, _ethUsdAt = 0;
export async function ethUsd() {
  // 5-min memoized native-token price. Robinhood Chain pairs price in ETH-equivalent.
  if (_ethUsd && Date.now() - _ethUsdAt < 5 * 60_000) return _ethUsd;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    _ethUsd = j?.ethereum?.usd || ETH_USD_FALLBACK;
  } catch { _ethUsd = ETH_USD_FALLBACK; }
  _ethUsdAt = Date.now();
  return _ethUsd;
}

export const xHandle = (url) => {
  if (!url) return null;
  const m = String(url).match(/(?:x|twitter)\.com\/(@?[A-Za-z0-9_]{1,15})/i);
  return m ? m[1].replace('@', '').toLowerCase() : null;
};

// guard: adapter output must at least have a CA, else it's junk
export const valid = (row) => row && /^0x[0-9a-fA-F]{40}$/.test(row.ca || '');
