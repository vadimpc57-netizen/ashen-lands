// Пепельные земли — игровой сервер. Без зависимостей: node server.js
// Каждая комната — отдельная копия игры, которая считается ЗДЕСЬ, на сервере (в изолированном vm).
// Телефоны игроков — только экраны: шлют действия и получают состояние. Свернул игру — партия не ломается.
// Переменные окружения: PORT (8080), BOT_TOKEN (проверка подписи Telegram; без него режим разработки),
// ORIGIN (разрешённый Origin для CORS, по умолчанию любой), GAME_FILE (путь к index.html, по умолчанию рядом),
// AUTOSKIP_MS (через сколько мс пропускать ход отключившегося игрока, по умолчанию 75000).
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path'), vm = require('vm');
const PORT = +process.env.PORT || 8080, BOT = process.env.BOT_TOKEN || '', ORIGIN = process.env.ORIGIN || '*';
const AUTOSKIP = +process.env.AUTOSKIP_MS || 75000;
const GAME_FILE = process.env.GAME_FILE || path.join(__dirname, 'index.html');
const MAX_ROOMS = 40, MAX_MEMBERS = 8, MAX_BODY = 20000, IDLE_MS = 6 * 3600e3;

let GAME_JS = '';
try { const h = fs.readFileSync(GAME_FILE, 'utf8'); const m = h.match(/<script>([\s\S]*)<\/script>/); GAME_JS = m ? m[1] : ''; } catch (e) {}
if (!GAME_JS) { console.error('Не найден файл игры (' + GAME_FILE + '). Положите index.html рядом с server.js.'); process.exit(1); }
const GAME_SCRIPT = new vm.Script(GAME_JS, { filename: 'game.js' });

const rooms = new Map(); // code -> room
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const rid = n => Array.from(crypto.randomBytes(n), b => ALPHA[b % ALPHA.length]).join('');
const hits = new Map();

function tgUser(init) {
  try {
    const p = new URLSearchParams(init), hash = p.get('hash'); p.delete('hash');
    const str = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
    const key = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
    const h = crypto.createHmac('sha256', key).update(str).digest('hex');
    if (!hash || h.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash))) return null;
    if (Date.now() / 1000 - (+p.get('auth_date') || 0) > 86400) return null;
    const u = JSON.parse(p.get('user') || 'null'); return u && u.id ? 'tg' + u.id : null;
  } catch (e) { return null; }
}
function who(init, wanted) {
  if (BOT) return tgUser(init);
  return /^[A-Za-z0-9_-]{8,40}$/.test(wanted || '') ? wanted : rid(16);
}
function cors(res) { res.setHeader('Access-Control-Allow-Origin', ORIGIN); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); }
function json(res, code, o) { cors(res); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }
function body(req) {
  return new Promise((ok, no) => {
    let n = 0; const a = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { no(new Error('big')); req.destroy(); } else a.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(a).toString() || '{}')); } catch (e) { no(new Error('json')); } });
    req.on('error', no);
  });
}
function sse(res, o) { try { res.write('data: ' + JSON.stringify(o) + '\n\n'); } catch (e) {} }
function limited(ip) {
  const now = Date.now(), h = hits.get(ip) || { t: now, n: 0 };
  if (now - h.t > 10000) { h.t = now; h.n = 0; } h.n++; hits.set(ip, h); return h.n > 600;
}

/* ---------- комната = игра в vm ---------- */
function makeRoom(code, creator) {
  const el = { innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}, remove() {}, appendChild() {}, querySelector: () => null, getContext: null };
  const sandbox = {
    document: { getElementById: () => el }, window: {}, navigator: {}, location: { search: '', origin: '', pathname: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console, Math, JSON, Date, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => Promise.reject(new Error('no net')), EventSource: function () {},
  };
  const r = { code, creator, members: new Set(), conns: new Map(), snap: null, last: Date.now(), off: new Map(), ctx: vm.createContext(sandbox), dead: false };
  sandbox.__out = (msg, to) => {
    if (r.dead) return;
    if (msg && msg.t === 'snap') r.snap = msg.s;
    if (to) { const c = r.conns.get(to); if (c) sse(c, { msg }); } else r.conns.forEach(c => sse(c, { msg }));
  };
  GAME_SCRIPT.runInContext(r.ctx);
  vm.runInContext(`
    NET.on = true; NET.role = 'host'; NET.srvMode = true; NET.id = 'srv'; NET.room = ${JSON.stringify(code)}; NET.creator = ${JSON.stringify(creator)};
    netSend = function (msg, to) { __out(msg, to); };
    netBar = function () {}; netTurnWatch = function () {}; netRoPaint = function () {}; netTick = function () {};
    netPush = function () { if (!NET.on) return; netSend({ t: 'snap', s: netSnap() }); };
    render();
  `, r.ctx);
  return r;
}
function feed(r, from, msg) {
  r.ctx.__m = { from, msg };
  try { vm.runInContext('netHostMsg(__m)', r.ctx, { timeout: 2000 }); } catch (e) { console.error('room ' + r.code + ':', e.message); }
}
function presence(r) {
  feed(r, 'server', { t: 'presence', on: [...r.conns.keys()], members: [...r.members] });
}
function closeRoom(code) {
  const r = rooms.get(code); if (!r) return; r.dead = true;
  r.conns.forEach(c => { try { c.end(); } catch (e) {} }); rooms.delete(code);
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), ip = req.socket.remoteAddress;
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  if (limited(ip)) return json(res, 429, { err: 'Слишком часто' });
  try {
    if (u.pathname === '/' || u.pathname === '/api/ping') return json(res, 200, { ok: true, rooms: rooms.size, v: 2 });
    if (u.pathname === '/api/events' && req.method === 'GET') {
      const code = u.searchParams.get('room'), r = rooms.get(code); let id = u.searchParams.get('id');
      if (BOT) id = tgUser(u.searchParams.get('init') || '');
      if (!r || !id || !r.members.has(id)) return json(res, 404, { err: 'Комната не найдена' });
      cors(res); res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      const old = r.conns.get(id); if (old && old !== res) { try { old.end(); } catch (e) {} }
      r.conns.set(id, res); r.off.delete(id); r.last = Date.now();
      if (r.snap) sse(res, { msg: { t: 'snap', s: r.snap } });
      presence(r);
      req.on('close', () => { if (r.conns.get(id) === res) { r.conns.delete(id); r.off.set(id, Date.now()); presence(r); } });
      return;
    }
    if (req.method !== 'POST') return json(res, 404, { err: 'нет такого' });
    const b = await body(req);
    if (u.pathname === '/api/create') {
      const id = who(b.init, b.id); if (!id) return json(res, 401, { err: 'Нужна авторизация Telegram' });
      if (rooms.size >= MAX_ROOMS) return json(res, 503, { err: 'Сервер переполнен, попробуйте позже' });
      let code; do { code = rid(5); } while (rooms.has(code));
      const r = makeRoom(code, id); r.members.add(id); rooms.set(code, r);
      return json(res, 200, { code, id });
    }
    if (u.pathname === '/api/join') {
      const r = rooms.get(String(b.room || '').toUpperCase()); if (!r) return json(res, 404, { err: 'Комната не найдена' });
      const id = who(b.init, b.id); if (!id) return json(res, 401, { err: 'Нужна авторизация Telegram' });
      if (!r.members.has(id) && r.members.size >= MAX_MEMBERS) return json(res, 409, { err: 'Комната заполнена' });
      const isNew = !r.members.has(id); r.members.add(id); r.last = Date.now(); if (isNew) presence(r);
      return json(res, 200, { id });
    }
    if (u.pathname === '/api/send') {
      const r = rooms.get(b.room); let id = b.id; if (BOT) id = tgUser(b.init || '');
      if (!r || !id || !r.members.has(id)) return json(res, 404, { err: 'Комната не найдена' });
      if (!b.msg || typeof b.msg !== 'object') return json(res, 400, { err: 'пусто' });
      r.last = Date.now(); r.off.delete(id);
      feed(r, id, b.msg);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { err: 'нет такого' });
  } catch (e) { console.error('request error:', e && e.stack || e); json(res, 400, { err: 'Плохой запрос' }); }
}).listen(PORT, () => console.log('Пепельные земли: сервер на порту ' + PORT + (BOT ? ' (Telegram-авторизация включена)' : ' (режим разработки, без авторизации)')));

setInterval(() => {
  const now = Date.now();
  rooms.forEach((r, code) => {
    if (now - r.last > IDLE_MS) { closeRoom(code); return; }
    r.conns.forEach(x => { try { x.write(': hb\n\n'); } catch (e) {} });
    try {
      vm.runInContext('netRosterTick()', r.ctx, { timeout: 1000 });
      // игрок, чей сейчас ход, пропал надолго — пропускаем его ход, чтобы партия не вставала
      const cur = vm.runInContext("G.screen === 'game' && G.players[G.cur] ? G.players[G.cur].owner : ''", r.ctx);
      if (cur && !r.conns.has(cur) && now - (r.off.get(cur) || now) > AUTOSKIP) {
        r.off.set(cur, now); vm.runInContext("netSkip(); netSchedule();", r.ctx, { timeout: 1000 });
      }
    } catch (e) { console.error('tick', code, e.message); }
  });
  hits.forEach((h, k) => { if (now - h.t > 60000) hits.delete(k); });
}, 2500);
