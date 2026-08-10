// ON-CHAIN PRICE READER — launchpad-agnostic. Reads a token's market data straight from its
// Uniswap pool, so any launchpad works with no API: pons, arena, bankr, or whatever ships next.
//
// These pools are V3-style: getReserves() reverts, slot0() works. Price comes from
// sqrtPriceX96; depth from the pool's token balances; mcap from totalSupply.
// Values resolve to USD because the quote side is WETH.

const RPC = 'https://rpc.mainnet.chain.robinhood.com';

// selectors
const SEL = {
  slot0:       '0x3850c7bd',
  token0:      '0x0dfe1681',
  token1:      '0xd21220a7',
  balanceOf:   '0x70a08231',
  totalSupply: '0x18160ddd',
  decimals:    '0x313ce567',
  symbol:      '0x95d89b41',
  name:        '0x06fdde03',
};

async function rpc(method, params, timeout = 8000) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'user-agent': 'Mozilla/5.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeout),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const addrArg = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const big = (h) => (h && h !== '0x' ? BigInt(h) : 0n);

function decodeString(hex) {
  if (!hex || hex === '0x') return null;
  try {
    const b = hex.slice(2);
    const len = parseInt(b.slice(64, 128), 16);
    if (!len || len > 200) return null;
    return Buffer.from(b.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\u0000/g, '').trim() || null;
  } catch { return null; }
}

export async function tokenIdentity(ca) {
  try {
    const [n, s] = await Promise.all([call(ca, SEL.name), call(ca, SEL.symbol)]);
    return { name: decodeString(n), symbol: decodeString(s) };
  } catch { return { name: null, symbol: null }; }
}

// Full market read for one token. Returns null unless it produces real numbers.
//   { priceUsd, mcapUsd, liqUsd, supply }
export async function marketData({ token, pool, pairToken }, ethUsdPrice) {
  if (!token || !pool || !ethUsdPrice) return null;
  try {
    const [s0, t0hex, supHex] = await Promise.all([
      call(pool, SEL.slot0),
      call(pool, SEL.token0),
      call(token, SEL.totalSupply),
    ]);
    if (!s0 || s0 === '0x') return null;

    // slot0: sqrtPriceX96 occupies the first 32-byte word
    const sqrt = big('0x' + s0.slice(2, 66));
    if (sqrt === 0n) return null;
    // (sqrt / 2^96)^2 → token1-per-token0, via float (precision is fine at display scale)
    const ratio = Number(sqrt) / 2 ** 96;
    const priceT1perT0 = ratio * ratio;
    if (!isFinite(priceT1perT0) || priceT1perT0 <= 0) return null;

    const token0 = '0x' + t0hex.slice(-40);
    const tokenIsT0 = token0.toLowerCase() === token.toLowerCase();
    // price of our token, denominated in the quote (WETH) side
    const priceEth = tokenIsT0 ? priceT1perT0 : 1 / priceT1perT0;
    if (!isFinite(priceEth) || priceEth <= 0) return null;

    const supply = Number(big(supHex)) / 1e18;
    const priceUsd = priceEth * ethUsdPrice;
    const mcapUsd = supply > 0 ? priceUsd * supply : null;

    // depth = quote-side balance held by the pool, counted both sides
    let liqUsd = null;
    if (pairToken) {
      try {
        const q = await call(pairToken, SEL.balanceOf + addrArg(pool));
        const quoteBal = Number(big(q)) / 1e18;
        liqUsd = quoteBal * ethUsdPrice * 2;
      } catch {}
    }

    // reject dust — a pool with no real depth is not a displayable market
    if ((mcapUsd == null || mcapUsd < 1) && (liqUsd == null || liqUsd < 1)) return null;

    return { priceUsd, mcapUsd, liqUsd, supply };
  } catch {
    return null;
  }
}

// legacy V2 helper kept for completeness; these pools revert on it
export async function poolPrice(poolAddr, tokenAddr) {
  return null;
}
