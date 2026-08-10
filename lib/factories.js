// FACTORY REGISTRY + AUTO-DISCOVERY.
// Launchpads deploy tokens through factory contracts. Known factories get a label;
// UNKNOWN factories are auto-discovered from chain and surfaced as their own launchpad
// (labelled by contract) so a new launchpad shows up the day it launches — no code change.
//
// All verified on Robinhood Chain (4663) via Blockscout decoded events.

export const FACTORIES = {
  // pools.trade — UERC20Factory
  '0x000000e200088d55c39a11f609e5f667729ad49b': {
    launchpad: 'pools.trade', tokenParam: 'tokenAddress',
    site: (ca) => `https://pools.trade/t/${ca}`,
  },
  // noxa — LaunchFactory
  '0xa24d48d50fd7985c6de816eaf77c1a17d3593bbe': {
    launchpad: 'noxa', tokenParam: 'token',
    site: (ca) => `https://noxa.io/token/${ca}`,
  },
  // noxa second factory
  '0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb': {
    launchpad: 'noxa', tokenParam: 'token',
    site: (ca) => `https://noxa.io/token/${ca}`,
  },
  // pons
  '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb': {
    launchpad: 'pons', tokenParam: 'token',
    site: (ca) => `https://ponsfamily.com/token/${ca}`,
  },
  // arena
  '0x4ec0d15bc8d2f5a7eb4d14e789c92c7f7b96425d': {
    launchpad: 'arena', tokenParam: 'token',
    site: (ca) => `https://arena.social/token/${ca}`,
  },
  // bankr / Doppler
  '0x1b37d3a72082029c44b35b604ea473617580b69a': {
    launchpad: 'bankr', tokenParam: 'token',
    site: (ca) => `https://bankr.bot/token/${ca}`,
    sharedInfra: 'doppler',
  },
  // dontblink.family  ← NEW (from the CA you gave me)
  '0xf441cc979fa862f2674b9188a7b529cafd3ce204': {
    launchpad: 'dontblink', tokenParam: 'token',
    site: (ca) => `https://dontblink.family/token/${ca}`,
  },
  // letscash.fun  ← NEW (from the CA you gave me)
  '0x5bd1fbe78a78fe8236fa00cf48fbeba74ae34661': {
    launchpad: 'letscash', tokenParam: 'token',
    site: (ca) => `https://letscash.fun/token/${ca}`,
  },
};

// Factories that deploy things that are NOT launchpad memecoins — bridged assets and
// Robinhood's own tokenized stocks. Verified by attributing the chain's top tokens by market cap.
export const NON_LAUNCH_FACTORIES = new Set([
  '0xc302ccbc357a39a7231a681c61943b2dc032dd51', // BeaconProxyFactory — bridged (1INCH, SFI, ADX, FLAY)
  '0x4783c67b63de2b358ac5951a7d41f47a38f3c046', // ERC1967Proxy, Deployed(uid,stock,…) — tokenized stocks (NVDA, AAPL, SPCX)
]);

// Infrastructure tokens — wrapped native and stablecoins. Not launches, regardless of deployer.
export const EXCLUDE_TOKENS = new Set([
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // WETH (also the standard quote asset)
]);
export const EXCLUDE_SYMBOLS = new Set(['WETH','USDE','USDG','USDC','USDT','SYRUPUSDG','USDUC','DAI','WBTC']);

export const LAUNCHPADS = {
  'noxa':        { label: 'noxa' },
  'pools.trade': { label: 'pools.trade' },
  'pons':        { label: 'pons' },
  'arena':       { label: 'arena' },
  'bankr':       { label: 'bankr' },
  'dontblink':   { label: 'dontblink' },
  'letscash':    { label: 'letscash' },
};

// token-creation event names we recognise across launchpads
export const LAUNCH_EVENTS = ['TokenLaunched', 'TokenCreated', 'TokenDeployed'];

// candidate token param names, tried in order when a factory is unknown
export const TOKEN_PARAMS = ['token', 'tokenAddress', 'newToken', 'tokenAddr'];

// Unknown factories all group under 'other' — one bucket keeps the launchpad filter usable,
// while /api/discover still reports the distinct factory addresses for classification.
export const OTHER = 'other';

export function launchpadOf(factoryAddr) {
  const f = FACTORIES[(factoryAddr || '').toLowerCase()];
  if (f) return f.launchpad;
  // unknown factory → its own pseudo-launchpad, identified by address prefix
  return factoryAddr ? `pad:${factoryAddr.slice(0, 8)}` : 'unknown';
}

export const isKnown = (addr) => !!FACTORIES[(addr || '').toLowerCase()];