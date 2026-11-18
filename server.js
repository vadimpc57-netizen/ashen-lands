// Пепельные земли — сервер-ретранслятор комнат. Без зависимостей: node server.js
// Игра считается в браузере создателя комнаты (хоста); сервер только пересылает сообщения.
// Переменные окружения: PORT (по умолчанию 8080), BOT_TOKEN (проверка подписи Telegram initData; без неё — режим разработки),
// ORIGIN (разрешённый Origin для CORS, по умолчанию любой).
const http = require('http'), crypto = require('crypto');
const PORT = +process.env.PORT || 8080, BOT = process.env.BOT_TOKEN || '', ORIGIN = process.env.ORIGIN || '*';
const MAX_ROOMS = 300, MAX_MEMBERS = 8, MAX_BODY = 1.5e6, IDLE_MS = 12 * 3600e3;
const rooms = new Map(); // code -> {hostId, host:res|null, members:Set, conns:Map(id->res), snap:string|null, last:number}
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const rid = n => Array.from(crypto.randomBytes(n), b => ALPHA[b % ALPHA.length]).join('');
const hits = new Map();

function tgUser(init) { // https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
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
function who(init, wanted) { // кто это: в боевом режиме личность берётся из подписи Telegram
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
function presence(r) { if (r.host) sse(r.host, { from: 'server', msg: { t: 'presence', on: [...r.conns.keys()] } }); }
function limited(ip) {
  const now = Date.now(), h = hits.get(ip) || { t: now, n: 0 };
  if (now - h.t > 10000) { h.t = now; h.n = 0; } h.n++; hits.set(ip, h); return h.n > 400;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), ip = req.socket.remoteAddress;
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  if (limited(ip)) return json(res, 429, { err: 'Слишком часто' });
  try {
    if (u.pathname === '/' || u.pathname === '/api/ping') return json(res, 200, { ok: true, rooms: rooms.size });
    if (u.pathname === '/api/events' && req.method === 'GET') {
      const code = u.searchParams.get('room'), r = rooms.get(code); let id = u.searchParams.get('id');
      if (BOT) id = tgUser(u.searchParams.get('init') || '');
      if (!r || !id || (id !== r.hostId && !r.members.has(id))) return json(res, 404, { err: 'Комната не найдена' });
      cors(res); res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      const old = id === r.hostId ? r.host : r.conns.get(id); if (old && old !== res) { try { old.end(); } catch (e) {} }
      if (id === r.hostId) { r.host = res; presence(r); if (r.snap) {/* хост сам помнит состояние */} }
      else { r.conns.set(id, res); if (r.snap) sse(res, { msg: { t: 'snap', s: r.snap } }); if (r.host) sse(r.host, { from: id, msg: { t: 'hello' } }); presence(r); }
      r.last = Date.now();
      req.on('close', () => { if (id === r.hostId) { if (r.host === res) r.host = null; } else if (r.conns.get(id) === res) { r.conns.delete(id); presence(r); } });
      return;
    }
    if (req.method !== 'POST') return json(res, 404, { err: 'нет такого' });
    const b = await body(req);
    if (u.pathname === '/api/create') {
      const id = who(b.init, b.id); if (!id) return json(res, 401, { err: 'Нужна авторизация Telegram' });
      if (b.code && rooms.has(b.code)) { const r = rooms.get(b.code); if (r.hostId !== id) return json(res, 403, { err: 'Комната занята' }); r.last = Date.now(); return json(res, 200, { code: b.code, id }); }
      if (b.code) return json(res, 404, { err: 'Комнаты уже нет' });
      if (rooms.size >= MAX_ROOMS) return json(res, 503, { err: 'Сервер переполнен' });
      let code; do { code = rid(5); } while (rooms.has(code));
      rooms.set(code, { hostId: id, host: null, members: new Set(), conns: new Map(), snap: null, last: Date.now() });
      return json(res, 200, { code, id });
    }
    if (u.pathname === '/api/join') {
      const r = rooms.get(String(b.room || '').toUpperCase()); if (!r) return json(res, 404, { err: 'Комната не найдена' });
      const id = who(b.init, b.id); if (!id) return json(res, 401, { err: 'Нужна авторизация Telegram' });
      if (id !== r.hostId && !r.members.has(id) && r.members.size >= MAX_MEMBERS) return json(res, 409, { err: 'Комната заполнена' });
      if (id !== r.hostId) r.members.add(id);
      r.last = Date.now(); return json(res, 200, { id });
    }
    if (u.pathname === '/api/send') {
      const r = rooms.get(b.room); let id = b.id; if (BOT) id = tgUser(b.init || '');
      if (!r || !id || (id !== r.hostId && !r.members.has(id))) return json(res, 404, { err: 'Комната не найдена' });
      if (!b.msg || typeof b.msg !== 'object') return json(res, 400, { err: 'пусто' });
      r.last = Date.now();
      if (id === r.hostId) {
        if (b.msg.t === 'snap') { if (typeof b.msg.s !== 'string') return json(res, 400, { err: 'bad' }); r.snap = b.msg.s; }
        if (b.to) { const c = r.conns.get(b.to); if (c) sse(c, { msg: b.msg }); } else r.conns.forEach(c => sse(c, { msg: b.msg }));
        return json(res, 200, { ok: true });
      }
      if (!r.host) return json(res, 503, { err: 'Создатель комнаты не в сети' });
      if (JSON.stringify(b.msg).length > 4000) return json(res, 413, { err: 'Слишком большое сообщение' });
      sse(r.host, { from: id, msg: b.msg }); return json(res, 200, { ok: true });
    }
    json(res, 404, { err: 'нет такого' });
  } catch (e) { json(res, 400, { err: 'Плохой запрос' }); }
}).listen(PORT, () => console.log('Пепельные земли: сервер на порту ' + PORT + (BOT ? ' (Telegram-авторизация включена)' : ' (режим разработки, без авторизации)')));

setInterval(() => {
  const now = Date.now();
  rooms.forEach((r, c) => { if (now - r.last > IDLE_MS) { rooms.delete(c); return; } if (r.host) { try { r.host.write(': hb\n\n'); } catch (e) {} } r.conns.forEach(x => { try { x.write(': hb\n\n'); } catch (e) {} }); });
  hits.forEach((h, k) => { if (now - h.t > 60000) hits.delete(k); });
}, 15000);
