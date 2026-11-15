/* KRT Terminal — live data backend for Angel One SmartAPI
   Zero dependencies (Node 18+). Reads market data only — it never places orders.
   Env: ANGEL_API_KEY, ANGEL_CLIENT_ID, ANGEL_PIN (MPIN), ANGEL_TOTP_SECRET, ACCESS_KEY, ALLOW_ORIGIN, [ALL_FNO=true], [M1_DAYS=5] */
'use strict';
const http = require('http'), crypto = require('crypto'), zlib = require('zlib'), fs = require('fs'), path = require('path');
const E = process.env, PORT = E.PORT || 10000, API = E.ANGEL_BASE || 'https://apiconnect.angelone.in';
const ACCESS = E.ACCESS_KEY || '', ORIGIN = E.ALLOW_ORIGIN || '*', M1_DAYS = +E.M1_DAYS || 5, ALL_FNO = /^(1|true|yes)$/i.test(E.ALL_FNO || '');
const MASTER_URL = E.MASTER_URL || 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const IST = 330 * 6e4, istNow = () => Date.now() + IST, dayStart = t => Math.floor(t / 864e5) * 864e5, sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const fmtIST = t => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const log = (...a) => console.log(new Date().toISOString(), ...a);
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/* ---------- universe (same list as the terminal) ---------- */
const IDX = [
  { s: 'NIFTY', ex: 'NSE', tok: '99926000', look: 'NIFTY 50', name: 'NIFTY', oex: 'NFO' },
  { s: 'BANKNIFTY', ex: 'NSE', tok: '99926009', look: 'NIFTY BANK', name: 'BANKNIFTY', oex: 'NFO' },
  { s: 'FINNIFTY', ex: 'NSE', tok: '99926037', look: 'NIFTY FIN SERVICE', name: 'FINNIFTY', oex: 'NFO' },
  { s: 'SENSEX', ex: 'BSE', tok: '99919000', look: 'SENSEX', name: 'SENSEX', oex: 'BFO' }];
const STK = ['MCX', 'NYKAA', 'PAYTM', 'PNB', 'SONACOMS', 'PHOENIXLTD', 'KALYANKJIL', 'IDEA', 'YESBANK', 'SUZLON', 'MANAPPURAM', 'INOXWIND', 'CANBK', 'HDFCBANK', 'NMDC', 'RELIANCE', 'AMBER', 'ICICIBANK', 'SBIN', 'BAJFINANCE', 'BHARTIARTL', 'BSE', 'ALKEM', 'PIDILITIND', 'SHRIRAMFIN', 'TMPV', 'PETRONET', 'MUTHOOTFIN', 'BPCL', 'RVNL', 'POLICYBZR', 'CUMMINSIND', 'ANGELONE', 'INDUSTOWER', 'ABB']
  .concat((E.EXTRA_STOCKS || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
const MCXL = [{ s: 'GOLDM', alt: 'GOLD' }, { s: 'SILVERM', alt: 'SILVER' }, { s: 'CRUDEOILM', alt: 'CRUDEOIL' }, { s: 'NATGASMINI', alt: 'NATURALGAS' }];

/* ---------- state ---------- */
const ST = { jwt: null, loggedIn: false, error: '', uni: [], bySym: {}, byTok: {}, quotes: {}, qt: 0, chains: {}, bars: {}, opt: {}, hot: {}, errors: [], missing: [], oi0: {}, oiDay: 0, master: false };
function err(m) { ST.errors.unshift(new Date().toISOString() + ' ' + m); ST.errors.length = Math.min(ST.errors.length, 25); log('ERR', m); }

/* ---------- TOTP (RFC 6238) ---------- */
function b32(s) { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; s = s.replace(/[\s=-]/g, '').toUpperCase(); let bits = ''; for (const c of s) { const v = A.indexOf(c); if (v < 0) throw new Error('ANGEL_TOTP_SECRET is not valid base32'); bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
function totp(secret) { const c = Math.floor(Date.now() / 30000), buf = Buffer.alloc(8); buf.writeUInt32BE(Math.floor(c / 2 ** 32), 0); buf.writeUInt32BE(c >>> 0, 4); const h = crypto.createHmac('sha1', b32(secret)).update(buf).digest(), o = h[h.length - 1] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); }

/* ---------- Angel API ---------- */
function hdr(auth) { const h = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-UserType': 'USER', 'X-SourceID': 'WEB', 'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1', 'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': E.ANGEL_API_KEY || '' }; if (auth) h.Authorization = 'Bearer ' + ST.jwt; return h; }
async function login() {
  const need = ['ANGEL_API_KEY', 'ANGEL_CLIENT_ID', 'ANGEL_PIN', 'ANGEL_TOTP_SECRET'].filter(k => !E[k]);
  if (need.length) { ST.error = 'Missing environment variables: ' + need.join(', '); throw new Error(ST.error); }
  const r = await fetch(API + '/rest/auth/angelbroking/user/v1/loginByPassword', { method: 'POST', headers: hdr(false), body: JSON.stringify({ clientcode: E.ANGEL_CLIENT_ID, password: E.ANGEL_PIN, totp: totp(E.ANGEL_TOTP_SECRET) }) });
  const j = await r.json().catch(() => ({}));
  if (!j.status || !j.data || !j.data.jwtToken) { ST.loggedIn = false; ST.error = 'Angel login failed: ' + (j.message || ('HTTP ' + r.status)) + ' ' + (j.errorcode || ''); throw new Error(ST.error); }
  ST.jwt = j.data.jwtToken; ST.loggedIn = true; ST.error = ''; log('Angel login OK');
}
function limiter(gap) { let last = 0, chain = Promise.resolve(); return fn => { const p = chain.then(async () => { const w = last + gap - Date.now(); if (w > 0) await sleep(w); last = Date.now(); return fn(); }); chain = p.catch(() => { }); return p; }; }
const qQuote = limiter(350), qHist = limiter(+E.HIST_GAP_MS || 1100);
async function call(path, body, q) {
  return q(async () => {
    for (let a = 0; a < 4; a++) {
      if (!ST.jwt) await login();
      const r = await fetch(API + path, { method: 'POST', headers: hdr(true), body: JSON.stringify(body) });
      const txt = await r.text(); let j;
      if (/exceeding access rate|rate limit|too many/i.test(txt) || r.status === 429) { ST.rateHits = (ST.rateHits || 0) + 1; await sleep(2500 * (a + 1)); continue; }
      try { j = JSON.parse(txt); } catch (e) { throw new Error('HTTP ' + r.status + ' ' + txt.slice(0, 120)); }
      if (j.status === false && /AG800[123]|invalid token|token expired/i.test((j.errorcode || '') + ' ' + (j.message || ''))) { ST.jwt = null; continue; }
      if (j.status === false) throw new Error((j.message || 'error') + ' ' + (j.errorcode || ''));
      return j.data;
    }
    throw new Error('Angel rate limit / re-login retries exhausted');
  });
}
const QUOTE = '/rest/secure/angelbroking/market/v1/quote/';
const HIST = '/rest/secure/angelbroking/historical/v1/getCandleData';
async function hist(exch, tok, interval, from, to) {
  const d = await call(HIST, { exchange: exch, symboltoken: tok, interval, fromdate: fmtIST(from), todate: fmtIST(to) }, qHist);
  return (d || []).map(r => [Date.parse(r[0]) + IST, +r[1], +r[2], +r[3], +r[4], +r[5] || 0]).filter(r => isFinite(r[0]));
}

/* ---------- scrip master → universe ---------- */
function parseExp(s, exch) { const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(String(s || '').toUpperCase()); if (!m) return null; return Date.UTC(+m[3], MON[m[2]], +m[1], exch === 'MCX' ? 23 : 15, exch === 'MCX' ? 30 : 30); }
function nearestOpts(groups, name, exch, it) {
  const list = groups[name + '|' + exch + '|' + it]; if (!list || !list.length) return null;
  const now = istNow(), byExp = {};
  for (const x of list) { const e = parseExp(x.expiry, exch); if (e && e > now) (byExp[e] = byExp[e] || []).push(x); }
  const exps = Object.keys(byExp).map(Number).sort((a, b) => a - b); if (!exps.length) return null;
  const exp = exps[0], map = new Map(); let lot = 0;
  for (const x of byExp[exp]) { const K = Math.round(parseFloat(x.strike) / 100 * 100) / 100, t = /CE$/.test(x.symbol) ? 'ce' : /PE$/.test(x.symbol) ? 'pe' : null; if (!t || !(K > 0)) continue; const c = map.get(K) || {}; c[t] = x.token; map.set(K, c); lot = +x.lotsize || lot; }
  const Ks = [...map.keys()].sort((a, b) => a - b), diffs = {};
  for (let i = 1; i < Ks.length; i++) { const d = Math.round((Ks[i] - Ks[i - 1]) * 100) / 100; diffs[d] = (diffs[d] || 0) + 1; }
  const step = +Object.entries(diffs).sort((a, b) => b[1] - a[1])[0]?.[0] || 1;
  return { exp, lot, step, map, name };
}
async function loadMaster() {
  log('Downloading scrip master…'); const r = await fetch(MASTER_URL); if (!r.ok) throw new Error('scrip master HTTP ' + r.status);
  let all = await r.json(); log('scrip master rows', all.length);
  const groups = {}, eq = {}, idx = {};
  for (const x of all) {
    const it = x.instrumenttype;
    if (it === 'OPTIDX' || it === 'OPTSTK' || it === 'OPTFUT' || it === 'FUTCOM') { const k = x.name + '|' + x.exch_seg + '|' + it; (groups[k] = groups[k] || []).push(x); }
    else if (x.exch_seg === 'NSE' && /-EQ$/.test(x.symbol)) eq[x.symbol.slice(0, -3)] = x;
    else if (it === 'AMXIDX') idx[(x.exch_seg + '|' + x.symbol).toUpperCase()] = x.token;
  }
  all = null;
  const uni = [], missing = [];
  for (const i of IDX) uni.push({ s: i.s, seg: 'IDX', ex: i.ex, tok: idx[(i.ex + '|' + i.look).toUpperCase()] || i.tok, oex: i.oex, opt: nearestOpts(groups, i.name, i.oex, 'OPTIDX') });
  let stocks = STK.slice();
  if (ALL_FNO) for (const k of Object.keys(groups)) { const [n, ex, it] = k.split('|'); if (ex === 'NFO' && it === 'OPTSTK' && !stocks.includes(n)) stocks.push(n); }
  for (const s of stocks) { const e = eq[s]; if (!e) { missing.push(s); continue; } uni.push({ s, seg: 'STK', ex: 'NSE', tok: e.token, oex: 'NFO', opt: nearestOpts(groups, s, 'NFO', 'OPTSTK') }); }
  for (const m of MCXL) {
    const futs = (groups[m.s + '|MCX|FUTCOM'] || []).map(x => ({ x, e: parseExp(x.expiry, 'MCX') })).filter(o => o.e && o.e > istNow()).sort((a, b) => a.e - b.e);
    if (!futs.length) { missing.push(m.s); continue; }
    uni.push({ s: m.s, seg: 'MCX', ex: 'MCX', tok: futs[0].x.token, futExp: futs[0].e, oex: 'MCX', opt: nearestOpts(groups, m.s, 'MCX', 'OPTFUT') || nearestOpts(groups, m.alt, 'MCX', 'OPTFUT') });
  }
  ST.uni = uni; ST.bySym = {}; ST.byTok = {};
  for (const u of uni) { ST.bySym[u.s] = u; ST.byTok[u.ex + '|' + u.tok] = u; }
  ST.missing = missing; ST.master = true;
  log('universe', uni.length, 'missing', missing.join(',') || 'none');
}

/* ---------- loops ---------- */
function mktOpen(seg) { const d = new Date(istNow()), w = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes(); if (!w || w === 6) return false; return seg === 'MCX' ? m >= 540 && m < 1410 : m >= 555 && m < 930; }
const anyOpen = () => mktOpen('NSE') || mktOpen('MCX');
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const feedTs = s => { const m = /(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})/.exec(s || ''); return m ? Date.UTC(+m[3], MON[m[2].toUpperCase()], +m[1], +m[4], +m[5], +m[6]) : null; };

async function quoteLoop() {
  for (; ;) {
    try {
      for (const g of chunk(ST.uni, 50)) {
        const ex = {}; for (const u of g) (ex[u.ex] = ex[u.ex] || []).push(u.tok);
        const d = await call(QUOTE, { mode: 'FULL', exchangeTokens: ex }, qQuote), t = istNow();
        for (const f of (d && d.fetched) || []) { const u = ST.byTok[f.exchange + '|' + f.symbolToken]; if (!u) continue; ST.quotes[u.s] = { ltp: +f.ltp, prev: +f.close, open: +f.open, high: +f.high, low: +f.low, vol: +f.tradeVolume || 0, oi: +f.opnInterest || 0, ft: feedTs(f.exchFeedTime) || t, t }; }
      }
      ST.qt = istNow();
    } catch (e) { err('quotes: ' + e.message); }
    await sleep(anyOpen() ? 2000 : 30000);
  }
}
async function refreshChain(u) {
  if (!u.opt) return; const q = ST.quotes[u.s]; if (!q || !q.ltp) return;
  const S = q.ltp, Ks = [...u.opt.map.keys()].sort((a, b) => a - b); let i = Ks.findIndex(k => k >= S); if (i < 0) i = Ks.length - 1;
  const sel = Ks.slice(Math.max(0, i - 10), i + 11), toks = [];
  for (const K of sel) { const c = u.opt.map.get(K); if (c.ce) toks.push(c.ce); if (c.pe) toks.push(c.pe); }
  const d = await call(QUOTE, { mode: 'FULL', exchangeTokens: { [u.oex]: toks.slice(0, 50) } }, qQuote), m = {};
  for (const f of (d && d.fetched) || []) m[f.symbolToken] = f;
  const t = istNow(), day = dayStart(t); if (ST.oiDay !== day) { ST.oiDay = day; ST.oi0 = {}; }
  const pick = tok => { const r = m[tok]; if (!r) return null; const oi = +r.opnInterest || 0; if (ST.oi0[tok] == null && oi > 0) ST.oi0[tok] = oi; const b = r.depth && r.depth.buy && r.depth.buy[0], s = r.depth && r.depth.sell && r.depth.sell[0]; return { ltp: +r.ltp, bid: b ? +b.price : 0, ask: s ? +s.price : 0, bq: b ? +b.quantity : 0, sq: s ? +s.quantity : 0, oi, chg: oi - (ST.oi0[tok] ?? oi), vol: +r.tradeVolume || 0 }; };
  const rows = sel.map(K => { const c = u.opt.map.get(K); return { K, ce: c.ce ? pick(c.ce) : null, pe: c.pe ? pick(c.pe) : null }; });
  const ch = ST.chains[u.s] || (ST.chains[u.s] = { snaps: [] });
  Object.assign(ch, { t, S, exp: u.opt.exp, rows });
  const ls = ch.snaps[ch.snaps.length - 1];
  if (!ls || t - ls.t >= 55e3) { ch.snaps.push({ t, S, r: rows.map(r => [r.K, r.ce ? r.ce.oi : 0, r.pe ? r.pe.oi : 0, r.ce ? r.ce.ltp : 0, r.pe ? r.pe.ltp : 0]) }); while (ch.snaps.length && t - ch.snaps[0].t > 150 * 6e4) ch.snaps.shift(); }
}
async function chainLoop() {
  let i = 0;
  for (; ;) {
    try {
      for (const s of Object.keys(ST.hot)) { if (Date.now() - ST.hot[s] > 30000) { delete ST.hot[s]; continue; } const u = ST.bySym[s]; if (u && Date.now() - (u.lc || 0) > 4000) { u.lc = Date.now(); await refreshChain(u); } }
      const list = ST.uni.filter(u => u.opt);
      if (list.length) { const u = list[i++ % list.length]; if (Date.now() - (u.lc || 0) > 15000) { u.lc = Date.now(); await refreshChain(u); } }
    } catch (e) { err('chain: ' + e.message); }
    await sleep(anyOpen() ? 600 : 3000);
  }
}
function trimDays(m, n) { const days = [...new Set(m.map(r => dayStart(r[0])))].slice(-n); const f = days[0] || 0; return m.filter(r => r[0] >= f); }
function merge(m, nb) { for (const r of nb) { let i = m.length - 1, done = false; for (; i >= 0 && m[i][0] >= r[0]; i--) if (m[i][0] === r[0]) { m[i] = r; done = true; break; } if (!done && (!m.length || r[0] > m[m.length - 1][0])) m.push(r); } }
async function barLoop() {
  for (; ;) {
    for (const u of ST.uni) {
      try {
        const b = ST.bars[u.s], now = istNow();
        if (!b) {
          const m1 = await hist(u.ex, u.tok, 'ONE_MINUTE', now - (M1_DAYS + 6) * 864e5, now);
          const d1 = await hist(u.ex, u.tok, 'ONE_DAY', now - 420 * 864e5, now);
          ST.bars[u.s] = { d1, m1: trimDays(m1, M1_DAYS), at: Date.now(), upd: now };
        } else if (mktOpen(u.seg) && Date.now() - b.at > 45000) {
          const from = b.m1.length ? b.m1[b.m1.length - 1][0] - 2 * 6e4 : now - 864e5;
          const nb = await hist(u.ex, u.tok, 'ONE_MINUTE', from, now); merge(b.m1, nb); b.m1 = trimDays(b.m1, M1_DAYS); b.at = Date.now(); b.upd = now;
        }
      } catch (e) { err('bars ' + u.s + ': ' + e.message); }
    }
    await sleep(3000);
  }
}
async function optBars(u, K, type) {
  const c = u.opt && u.opt.map.get(K), tok = c && c[type === 'CE' ? 'ce' : 'pe']; if (!tok) return { m1: [], error: 'strike not in nearest expiry' };
  const o = ST.opt[tok]; if (o && Date.now() - o.at < 25000) return o;
  const now = istNow(), m1 = await hist(u.oex, tok, 'ONE_MINUTE', now - 6 * 864e5, now);
  return (ST.opt[tok] = { m1: trimDays(m1, 3), at: Date.now() });
}

/* ---------- HTTP ---------- */
function send(req, res, code, obj) {
  const body = JSON.stringify(obj), h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': '*', 'Cache-Control': 'no-store' };
  if (/gzip/.test(req.headers['accept-encoding'] || '') && body.length > 2048) { h['Content-Encoding'] = 'gzip'; res.writeHead(code, h); res.end(zlib.gzipSync(body)); }
  else { res.writeHead(code, h); res.end(body); }
}
const chainOut = (c, every) => c && { t: c.t, S: c.S, exp: c.exp, rows: c.rows, snaps: every ? c.snaps.filter((s, i, a) => i === a.length - 1 || i % every === 0).slice(-25) : c.snaps.slice(-95) };
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': '*' }); return res.end(); }
    if (u.pathname === '/health') return send(req, res, 200, { ok: true, service: 'krt-backend', loggedIn: ST.loggedIn, error: ST.error });
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const f = [path.join(__dirname, 'index.html'), path.join(__dirname, '..', 'index.html')].find(p => fs.existsSync(p));
      if (!f) return send(req, res, 200, { ok: true, service: 'krt-backend', loggedIn: ST.loggedIn, error: ST.error, note: 'index.html not found next to the backend' });
      const html = fs.readFileSync(f, 'utf8').replace('</head>', `<script>window.KRT_SAME_ORIGIN=1;window.KRT_NEEDS_KEY=${ACCESS ? 1 : 0};</script></head>`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(html);
    }
    if (ACCESS && (u.searchParams.get('key') || req.headers['x-access-key']) !== ACCESS) return send(req, res, 401, { error: 'wrong access key' });
    const p = u.searchParams;
    switch (u.pathname) {
      case '/api/status': return send(req, res, 200, { ok: true, loggedIn: ST.loggedIn, error: ST.error, master: ST.master, universe: ST.uni.length, barsLoaded: Object.keys(ST.bars).length, rateLimitRetries: ST.rateHits || 0, chains: Object.keys(ST.chains).length, missing: ST.missing, quotesAt: ST.qt, marketOpen: anyOpen(), serverTime: istNow(), errors: ST.errors.slice(0, 10) });
      case '/api/universe': return send(req, res, 200, { items: ST.uni.map(x => ({ s: x.s, seg: x.seg, ex: x.ex, lot: x.opt ? x.opt.lot : null, step: x.opt ? x.opt.step : null, exp: x.opt ? x.opt.exp : null, hasOptions: !!x.opt, optName: x.opt ? x.opt.name : null, px: ST.quotes[x.s] ? ST.quotes[x.s].ltp : null })) });
      case '/api/quotes': return send(req, res, 200, { t: ST.qt, q: ST.quotes });
      case '/api/bars': { const since = +p.get('since') || 0, out = {}; for (const s in ST.bars) { const b = ST.bars[s], m1 = since ? b.m1.filter(r => r[0] >= since) : b.m1; if (since && !m1.length) continue; out[s] = since ? { m1 } : { m1, d1: b.d1 }; } return send(req, res, 200, { t: istNow(), bars: out, loaded: Object.keys(ST.bars).length, total: ST.uni.length }); }
      case '/api/chain': { const s = p.get('sym'); ST.hot[s] = Date.now(); return send(req, res, 200, chainOut(ST.chains[s], 0) || {}); }
      case '/api/chains': { const out = {}; for (const s in ST.chains) out[s] = chainOut(ST.chains[s], 3); return send(req, res, 200, { chains: out }); }
      case '/api/optbars': { const x = ST.bySym[p.get('sym')]; if (!x) return send(req, res, 404, { error: 'unknown symbol' }); return send(req, res, 200, await optBars(x, +p.get('K'), p.get('type'))); }
      default: return send(req, res, 404, { error: 'not found' });
    }
  } catch (e) { err('http: ' + e.message); send(req, res, 500, { error: e.message }); }
});

(async () => {
  server.listen(PORT, () => log('KRT backend listening on', PORT));
  for (; ;) { try { await login(); break; } catch (e) { err(e.message); await sleep(60000); } }
  for (; ;) { try { await loadMaster(); break; } catch (e) { err('master: ' + e.message); await sleep(30000); } }
  quoteLoop(); chainLoop(); barLoop();
  setInterval(() => { const d = new Date(istNow()); if (d.getUTCHours() === 8 && d.getUTCMinutes() === 30) { ST.jwt = null; loadMaster().catch(e => err('daily master refresh: ' + e.message)); } }, 60000);
})();
