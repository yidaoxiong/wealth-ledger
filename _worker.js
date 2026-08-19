/* wealth-ledger Pages Worker：/api/* 云端同步接口（D1 存储） */

const RELAY_KEY = 'wl-relay-7f3k9q2m'; /* 仅用于中继 GitHub OAuth（github.com 被墙时备用） */

const J = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
const bad = (msg, status) => J({ error: msg }, status || 400);
const randToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
const validUser = (u) => typeof u === 'string' && u.length >= 1 && u.length <= 32 && /^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(u);

async function handleApi(request, env) {
  if (request.method !== 'POST') return bad('method_not_allowed', 405);
  let body;
  try { body = await request.json(); } catch { return bad('bad_json'); }
  const db = env.wealth_db;

  if (new URL(request.url).pathname === '/api/gh-relay') {
    /* 中继 GitHub OAuth（设备授权流）。仅放行 /login/ 开头路径 + 校验 key */
    const { subpath, form } = body;
    const key = request.headers.get('x-relay-key');
    if (key !== RELAY_KEY) return bad('bad_key', 401);
    if (typeof subpath !== 'string' || !subpath.startsWith('/login/')) return bad('bad_path');
    const up = await fetch('https://github.com' + subpath, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'wealth-ledger-relay' },
      body: typeof form === 'string' ? form : '',
    });
    const txt = await up.text();
    return new Response(txt, { status: up.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }

  const { username } = body;
  if (!validUser(username)) return bad('bad_username');

  switch (new URL(request.url).pathname) {
    case '/api/salt': {
      const row = await db.prepare('SELECT salt FROM users WHERE username = ?').bind(username).first();
      return row ? J({ salt: row.salt }) : bad('no_user', 404);
    }
    case '/api/register': {
      const { salt, hash } = body;
      if (typeof salt !== 'string' || !/^[0-9a-f]{32}$/.test(salt)) return bad('bad_salt');
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return bad('bad_hash');
      const token = randToken();
      try {
        await db.prepare('INSERT INTO users (username, salt, hash, token) VALUES (?, ?, ?, ?)').bind(username, salt, hash, token).run();
      } catch (e) {
        if (String(e).includes('UNIQUE')) return bad('exists', 409);
        throw e;
      }
      return J({ ok: true, token });
    }
    case '/api/login': {
      const { hash } = body;
      const row = await db.prepare('SELECT hash, token FROM users WHERE username = ?').bind(username).first();
      if (!row) return bad('no_user', 404);
      if (row.hash !== hash) return bad('bad_password', 401);
      /* 多设备共用同一 token：登录不轮换，避免把其他设备踢下线 */
      return J({ ok: true, token: row.token });
    }
    case '/api/pull': {
      const { token } = body;
      const u = await db.prepare('SELECT token FROM users WHERE username = ?').bind(username).first();
      if (!u) return bad('no_user', 404);
      if (u.token !== token) return bad('bad_token', 401);
      const d = await db.prepare('SELECT json, updated_at FROM data WHERE username = ?').bind(username).first();
      return J({ ok: true, data: d ? d.json : null, updated_at: d ? d.updated_at : null });
    }
    case '/api/push': {
      const { token, data } = body;
      if (typeof data !== 'string' || data.length > 1000000) return bad('bad_data');
      const u = await db.prepare('SELECT token FROM users WHERE username = ?').bind(username).first();
      if (!u) return bad('no_user', 404);
      if (u.token !== token) return bad('bad_token', 401);
      await db.prepare(
        'INSERT INTO data (username, json, updated_at) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(username) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at'
      ).bind(username, data).run();
      return J({ ok: true });
    }
    default:
      return bad('not_found', 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(request, env); }
      catch (e) { return bad('server_error:' + (e && e.message ? e.message : e), 500); }
    }
    return env.ASSETS.fetch(request);
  },
};
