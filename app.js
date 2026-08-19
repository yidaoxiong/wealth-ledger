'use strict';

const $ = (s) => document.querySelector(s);

/* ---------- 本地存储（每个浏览器独立，按用户名隔离） ---------- */
const LS_USERS = 'ledger_users_v1';
const LS_SESSION = 'ledger_session_v1';
const dataKey = (u) => 'ledger_data_v1_' + u;

function lsGet(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } }
function lsSet(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
function emptyData() { return { cash: [], funds: [], snapshots: [], earnings: [], expenses: [] }; }
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now() + Math.random().toString(16).slice(2));
const num = (n) => Number(n || 0);
const fmt = (n) => '¥' + Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function getUsers() { return lsGet(LS_USERS, {}); }
function curUser() { return localStorage.getItem(LS_SESSION) || null; }
function loadData() { const u = curUser(); return u ? lsGet(dataKey(u), emptyData()) : emptyData(); }
function saveData(d) {
  const u = curUser();
  if (!u) return;
  lsSet(dataKey(u), d);
  markDirty(u, true);
  schedulePush(u, d);
}

/* ---------- 云端同步（Cloudflare D1） ---------- */
const syncKey = (u) => 'ledger_sync_v1_' + u;
function getSync(u) { return lsGet(syncKey(u), {}); }
function setSync(u, obj) { lsSet(syncKey(u), obj); }
function markDirty(u, v) { const s = getSync(u); s.dirty = v; setSync(u, s); }

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error || 'http_' + res.status), { code: j.error, status: res.status });
  return j;
}

let pushTimer = null;
function setSyncStatus(kind) {
  const el = $('#sync-status');
  if (!el) return;
  if (kind === 'syncing') { el.textContent = '⟳ 同步中…'; el.className = 'sync-status'; }
  else if (kind === 'ok') { el.textContent = '☁️ 已同步 ' + new Date().toTimeString().slice(0, 5); el.className = 'sync-status ok'; }
  else if (kind === 'fail') { el.textContent = '⚠️ 云同步失败'; el.className = 'sync-status fail'; }
  else { el.textContent = ''; el.className = 'sync-status'; }
}
function schedulePush(u, data) {
  clearTimeout(pushTimer);
  setSyncStatus('syncing');
  pushTimer = setTimeout(async () => {
    const s = getSync(u);
    if (!s.token) return;
    try {
      await apiPost('/api/push', { username: u, token: s.token, data: JSON.stringify(data) });
      markDirty(u, false);
      setSyncStatus('ok');
    } catch (e) {
      if (e.code === 'bad_token' && (await reAuth(u))) {
        /* token 失效已自动重登，重试一次 */
        try {
          await apiPost('/api/push', { username: u, token: getSync(u).token, data: JSON.stringify(data) });
          markDirty(u, false);
          setSyncStatus('ok');
          return;
        } catch (e2) { setSyncStatus('fail'); return; }
      }
      console.warn('云端同步失败（下次保存会自动重试）', e.message);
      setSyncStatus('fail');
    }
  }, 1200);
}

/* token 失效时用本地凭据静默重登换新 token（多设备/历史遗留 token 自愈） */
async function reAuth(u) {
  const local = getUsers()[u];
  if (!local || !local.hash) return null;
  try {
    const j = await apiPost('/api/login', { username: u, hash: local.hash });
    const s = getSync(u);
    s.token = j.token;
    setSync(u, s);
    return j.token;
  } catch { return null; }
}

async function cloudPull(u) {
  const s = getSync(u);
  if (!s.token) return null;
  const j = await apiPost('/api/pull', { username: u, token: s.token });
  return j.data ? JSON.parse(j.data) : null;
}

/* 登录后同步：云端有最新数据且本地无未同步改动 → 采用云端；否则以本地为准并推送 */
async function syncAfterAuth(username) {
  const sync = getSync(username);
  if (!sync.token) return;
  try {
    const cloud = await cloudPull(username);
    if (cloud && !sync.dirty) {
      lsSet(dataKey(username), cloud);
      state.data = cloud;
      renderAll();
      setSyncStatus('ok');
    } else {
      schedulePush(username, lsGet(dataKey(username), emptyData()));
    }
  } catch (e) {
    if (e.code === 'bad_token' && (await reAuth(username))) {
      /* token 失效已自动重登，重拉一次 */
      try {
        const cloud = await cloudPull(username);
        if (cloud) { lsSet(dataKey(username), cloud); state.data = cloud; renderAll(); }
        setSyncStatus('ok');
        return;
      } catch (e2) { setSyncStatus('fail'); return; }
    }
    console.warn('云端拉取失败，先用本地数据', e.message);
    setSyncStatus('fail');
  }
}

/* ---------- 密码哈希（浏览器内 PBKDF2，盐值随机） ---------- */
function randSalt() { const a = new Uint8Array(16); crypto.getRandomValues(a); return [...a].map((b) => b.toString(16).padStart(2, '0')).join(''); }
async function hashPw(pw, salt) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 60000, hash: 'SHA-256' }, km, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const state = {
  username: null,
  data: null,
  earnPeriod: 'month',
  expPeriod: 'month',
  snapDraft: null,
};
const charts = {};

/* ---------- 登录 / 注册 ---------- */
let authMode = 'login';
function switchAuth(mode) {
  authMode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-reg').classList.toggle('active', mode === 'reg');
  $('#auth-submit').textContent = mode === 'login' ? '🚀 登录' : '🎉 注册并进入';
  $('#auth-msg').textContent = '';
}
function setMsg(text, ok) {
  const el = $('#auth-msg');
  el.textContent = text;
  el.classList.toggle('ok', !!ok);
}
async function doAuth(e) {
  e.preventDefault();
  const username = $('#auth-user').value.trim();
  const password = $('#auth-pass').value;
  if (!username || !password) return setMsg('用户名和密码都要填哦');
  setMsg(authMode === 'login' ? '登录中…' : '注册中…');
  const users = getUsers();
  try {
    let token = null;
    if (authMode === 'register' || authMode === 'reg') {
      /* ---- 注册：云端建账户 ---- */
      const salt = randSalt();
      const hash = await hashPw(password, salt);
      try {
        const j = await apiPost('/api/register', { username, salt, hash });
        token = j.token;
      } catch (err) {
        if (err.code === 'exists') return setMsg('这个用户名已经被注册啦');
        throw err;
      }
      users[username] = { salt, hash };
      lsSet(LS_USERS, users);
      if (!lsGet(dataKey(username), null)) lsSet(dataKey(username), emptyData());
      setSync(username, { token, dirty: false });
    } else {
      /* ---- 登录：云端验证 ---- */
      let salt;
      try {
        const j = await apiPost('/api/salt', { username });
        salt = j.salt;
      } catch (err) {
        if (err.code === 'no_user') {
          /* 云端没有，但本地有 → 老账户自动迁移上云 */
          const local = users[username];
          if (local && local.salt && local.hash) {
            try {
              const j = await apiPost('/api/register', { username, salt: local.salt, hash: local.hash });
              token = j.token;
              setSync(username, { token, dirty: true }); /* 本地数据需要推上云 */
            } catch (e2) {
              if (e2.code === 'exists') { /* 竞态：已被迁移，走正常登录 */ }
              else throw e2;
            }
          } else {
            return setMsg('用户名或密码不对哦');
          }
        } else throw err;
      }
      if (!token) {
        const hash = await hashPw(password, salt);
        try {
          const j = await apiPost('/api/login', { username, hash });
          token = j.token;
        } catch (err) {
          return setMsg('用户名或密码不对哦');
        }
        users[username] = { salt, hash };
        lsSet(LS_USERS, users);
        setSync(username, { token, dirty: getSync(username).dirty || false });
      }
    }
    localStorage.setItem(LS_SESSION, username);
    state.username = username;
    enterApp();
    syncAfterAuth(username);
  } catch (err) {
    setMsg('网络好像不太行，稍后再试～（' + (err && err.message ? err.message : err) + '）');
  }
  return false;
}
function doLogout() {
  localStorage.removeItem(LS_SESSION);
  state.username = null; state.data = null;
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  setMsg('');
}

/* ---------- 进入主界面 ---------- */
function enterApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#hello').textContent = '嗨，' + state.username + '！';
  const today = new Date().toISOString().slice(0, 10);
  if (!$('#earn-date').value) $('#earn-date').value = today;
  if (!$('#exp-date').value) $('#exp-date').value = today;
  if (!$('#snap-date').value) $('#snap-date').value = today;
  state.data = loadData();
  loadDraft($('#snap-date').value);
  renderAll();
}

function renderAll() {
  renderAssets();
  renderEarnings();
  renderExpenses();
}

/* ---------- 资产（按日期记录每个项目的当日市值） ---------- */
function snapTotals(s) {
  if (Array.isArray(s.entries)) {
    let cash = 0, fund = 0;
    s.entries.forEach((e) => {
      if (e.type === 'cash') cash += num(e.amount);
      else if (e.type === 'fund') fund += num(e.marketValue);
    });
    return { cash, fund, total: cash + fund };
  }
  /* 兼容旧格式汇总快照 {date,cash,fund,total} */
  return { cash: num(s.cash), fund: num(s.fund), total: num(s.total) };
}

function renderAssets() {
  const d = state.data;
  const snaps = [...d.snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const latest = snaps[snaps.length - 1];
  if (latest) {
    const t = snapTotals(latest);
    $('#sum-cash').textContent = fmt(t.cash);
    $('#sum-fund').textContent = fmt(t.fund);
    $('#sum-all').textContent = fmt(t.total);
    $('#latest-snap-date').textContent = '📅 最近记录：' + latest.date;
  } else {
    $('#sum-cash').textContent = fmt(0);
    $('#sum-fund').textContent = fmt(0);
    $('#sum-all').textContent = fmt(0);
    $('#latest-snap-date').textContent = '还没有资产记录，先记一笔吧～';
  }
  renderSnapEditor();
  renderSnapList();
  drawAssetChart();
}

/* ---- 当日快照编辑器（草稿在 state.snapDraft，保存才写入） ---- */
function loadDraft(date) {
  const s = state.data.snapshots.find((x) => x.date === date);
  const cash = [], fund = [];
  if (s && Array.isArray(s.entries)) {
    s.entries.forEach((e) => {
      if (e.type === 'cash') cash.push({ id: e.id || uid(), name: e.name, amount: e.amount });
      else if (e.type === 'fund') fund.push({ id: e.id || uid(), name: e.name, shares: e.shares, marketValue: e.marketValue });
    });
  } else if (s) {
    /* 旧格式汇总快照 → 转成条目（保存后即为新格式） */
    cash.push({ id: uid(), name: '现金（旧记录）', amount: num(s.cash) });
    fund.push({ id: uid(), name: '基金（旧记录）', shares: null, marketValue: num(s.fund) });
  }
  state.snapDraft = { date, cash, fund };
}

function onSnapDate() { loadDraft($('#snap-date').value); renderSnapEditor(); }

function addSnapCash() {
  const name = $('#snap-cash-name').value.trim();
  const amount = $('#snap-cash-amount').value;
  if (!name || amount === '') return alert('项目名称和当日市值都要填哦');
  state.snapDraft.cash.push({ id: uid(), name, amount: num(amount) });
  $('#snap-cash-name').value = ''; $('#snap-cash-amount').value = '';
  renderSnapEditor();
}
function addSnapFund() {
  const name = $('#snap-fund-name').value.trim();
  const shares = $('#snap-fund-shares').value;
  const marketValue = $('#snap-fund-value').value;
  if (!name || marketValue === '') return alert('基金名称和当日市值都要填哦');
  state.snapDraft.fund.push({ id: uid(), name, shares: shares === '' ? null : num(shares), marketValue: num(marketValue) });
  $('#snap-fund-name').value = ''; $('#snap-fund-shares').value = ''; $('#snap-fund-value').value = '';
  renderSnapEditor();
}
function delSnapItem(type, id) {
  const arr = state.snapDraft[type];
  const i = arr.findIndex((x) => x.id === id);
  if (i >= 0) arr.splice(i, 1);
  renderSnapEditor();
}
function delBtnDraft(type, id) {
  const b = document.createElement('button');
  b.className = 'del'; b.textContent = '✕'; b.title = '删除这个项目';
  b.onclick = () => delSnapItem(type, id);
  return b;
}

function renderSnapEditor() {
  const d = state.snapDraft || { date: '', cash: [], fund: [] };
  const cl = $('#snap-cash-list');
  cl.innerHTML = d.cash.length ? '' : '<li class="empty">还没有现金项目，上面加一个～</li>';
  d.cash.forEach((i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="name">${esc(i.name)}</span></span><span class="val">${fmt(i.amount)}</span>`;
    li.appendChild(delBtnDraft('cash', i.id));
    cl.appendChild(li);
  });
  const fl = $('#snap-fund-list');
  fl.innerHTML = d.fund.length ? '' : '<li class="empty">还没有基金项目，上面加一个～</li>';
  d.fund.forEach((i) => {
    const li = document.createElement('li');
    const meta = i.shares != null ? `份额 ${num(i.shares)} · ` : '';
    li.innerHTML = `<span><span class="name">${esc(i.name)}</span><span class="meta"> ${meta}当日市值</span></span><span class="val">${fmt(i.marketValue)}</span>`;
    li.appendChild(delBtnDraft('fund', i.id));
    fl.appendChild(li);
  });
  const cash = d.cash.reduce((s, i) => s + num(i.amount), 0);
  const fund = d.fund.reduce((s, i) => s + num(i.marketValue), 0);
  $('#snap-summary').textContent = `现金 ${fmt(cash)} + 基金 ${fmt(fund)} = 总资产 ${fmt(cash + fund)}`;
}

function saveSnapshot() {
  const date = $('#snap-date').value;
  if (!date) return alert('先选个日期哦');
  const d = state.snapDraft;
  if (!d || (!d.cash.length && !d.fund.length)) return alert('先添加至少一个项目再保存吧～');
  const entries = [
    ...d.cash.map((i) => ({ type: 'cash', id: i.id, name: i.name, amount: i.amount })),
    ...d.fund.map((i) => ({ type: 'fund', id: i.id, name: i.name, shares: i.shares, marketValue: i.marketValue })),
  ];
  const t = snapTotals({ entries });
  const snap = state.data.snapshots.find((x) => x.date === date);
  if (snap) snap.entries = entries;
  else state.data.snapshots.push({ date, entries });
  saveData(state.data);
  alert(date + ' 已保存：总资产 ' + fmt(t.total) + '（现金 ' + fmt(t.cash) + ' + 基金 ' + fmt(t.fund) + '）');
  renderAssets();
}

/* ---- 快照历史 ---- */
function renderSnapList() {
  const snaps = [...state.data.snapshots].sort((a, b) => b.date.localeCompare(a.date));
  const el = $('#snap-list');
  el.innerHTML = snaps.length ? '' : '<li class="empty">还没有快照，上面记一笔吧～</li>';
  snaps.forEach((s) => {
    const t = snapTotals(s);
    const li = document.createElement('li');
    li.className = 'snap-item';
    const detail = document.createElement('div');
    detail.className = 'snap-detail';
    detail.innerHTML = `<span class="name">📅 ${s.date}</span> <span class="meta">现金 ${fmt(t.cash)} · 基金 ${fmt(t.fund)} · 合计 <b style="color:#7132f5">${fmt(t.total)}</b></span>`;
    if (Array.isArray(s.entries) && s.entries.length) {
      const sub = document.createElement('ul');
      sub.className = 'snap-sub';
      s.entries.forEach((e) => {
        const subli = document.createElement('li');
        if (e.type === 'cash') subli.innerHTML = `<span>${esc(e.name)}</span><span>${fmt(e.amount)}</span>`;
        else subli.innerHTML = `<span>${esc(e.name)}</span><span>${e.shares != null ? num(e.shares) + ' 份 · ' : ''}${fmt(e.marketValue)}</span>`;
        sub.appendChild(subli);
      });
      detail.appendChild(sub);
    }
    li.appendChild(detail);
    const ops = document.createElement('div');
    ops.className = 'snap-ops';
    const eb = document.createElement('button');
    eb.className = 'del'; eb.textContent = '✎'; eb.title = '编辑这天';
    eb.onclick = () => { $('#snap-date').value = s.date; loadDraft(s.date); renderSnapEditor(); };
    const db = document.createElement('button');
    db.className = 'del'; db.textContent = '✕'; db.title = '删除这天';
    db.onclick = () => {
      if (!confirm('删除 ' + s.date + ' 的资产快照？')) return;
      state.data.snapshots = state.data.snapshots.filter((x) => x.date !== s.date);
      saveData(state.data);
      renderAssets();
    };
    ops.appendChild(eb); ops.appendChild(db);
    li.appendChild(ops);
    el.appendChild(li);
  });
}

function drawAssetChart() {
  const snaps = [...state.data.snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const labels = snaps.map((s) => s.date);
  const t = snaps.map((s) => snapTotals(s));
  const cfg = {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '总资产', data: t.map((x) => x.total), borderColor: '#7132f5', backgroundColor: 'rgba(113,50,245,0.10)', fill: true, tension: 0.3, borderWidth: 3 },
        { label: '现金', data: t.map((x) => x.cash), borderColor: '#5741d8', backgroundColor: 'transparent', tension: 0.3, borderWidth: 2 },
        { label: '基金', data: t.map((x) => x.fund), borderColor: '#9497a9', backgroundColor: 'transparent', tension: 0.3, borderWidth: 2 },
      ],
    },
    options: baseOpts('日期', '金额'),
  };
  drawChart('asset', 'asset-chart', cfg);
}

/* ---------- 赚钱 ---------- */
function renderEarnings() {
  const d = state.data;

  const totalSales = d.earnings.reduce((s, i) => s + num(i.sales), 0);
  const totalProfit = d.earnings.reduce((s, i) => s + num(i.profit), 0);
  const totalCost = d.earnings.reduce((s, i) => s + num(i.cost) * num(i.quantity), 0);
  $('#earn-summary').innerHTML = `
    <div class="sum-item"><span>总销售额</span><b style="color:#149e61">${fmt(totalSales)}</b></div>
    <div class="sum-item"><span>总盈利</span><b style="color:#7132f5">${fmt(totalProfit)}</b></div>
    <div class="sum-item"><span>总成本</span><b style="color:#686b82">${fmt(totalCost)}</b></div>
    <div class="sum-item"><span>记录笔数</span><b>${d.earnings.length}</b></div>`;

  const el = $('#earn-list');
  el.innerHTML = d.earnings.length ? '' : '<li class="empty">还没有赚钱记录，记一笔吧～</li>';
  [...d.earnings].reverse().forEach((i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="name">${esc(i.product)}</span><span class="meta"> ${i.date} · 销售额 ${fmt(i.sales)}</span></span><span class="val" style="color:#149e61">盈利 ${fmt(i.profit)}</span>`;
    li.appendChild(delBtn(d.earnings, i.id));
    el.appendChild(li);
  });

  drawEarnChart(groupEarn(d.earnings, state.earnPeriod));
}

function groupEarn(arr, period) {
  const salesMap = {}, profitMap = {};
  arr.forEach((e) => {
    const d = e.date || '';
    let label = period === 'year' ? d.slice(0, 4) : d.slice(0, 7);
    if (!label) label = '未知';
    salesMap[label] = (salesMap[label] || 0) + num(e.sales);
    profitMap[label] = (profitMap[label] || 0) + num(e.profit);
  });
  const labels = Object.keys(salesMap).sort();
  return { labels, sales: labels.map((l) => salesMap[l]), profit: labels.map((l) => profitMap[l]) };
}

function drawEarnChart(g) {
  const axis = state.earnPeriod === 'year' ? '年份' : '月份';
  const cfg = {
    type: 'bar',
    data: {
      labels: g.labels,
      datasets: [
        { label: '总收入', data: g.sales, backgroundColor: '#149e61', borderRadius: 8, maxBarThickness: 42 },
        { label: '盈利', data: g.profit, backgroundColor: '#7132f5', borderRadius: 8, maxBarThickness: 42 },
      ],
    },
    options: baseOpts(axis, '金额'),
  };
  drawChart('earn', 'earn-chart', cfg);
}

function setEarnPeriod(p) {
  state.earnPeriod = p;
  document.querySelectorAll('#tab-earn .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.p === p));
  drawEarnChart(groupEarn(state.data.earnings, p));
}

/* ---------- 开支 ---------- */
function renderExpenses() {
  const d = state.data;

  const total = d.expenses.reduce((s, i) => s + num(i.amount), 0);
  const count = d.expenses.length;
  const avg = count ? total / count : 0;
  $('#exp-summary').innerHTML = `
    <div class="sum-item"><span>总消费</span><b style="color:#e0413e">${fmt(total)}</b></div>
    <div class="sum-item"><span>平均单笔</span><b style="color:#7132f5">${fmt(avg)}</b></div>
    <div class="sum-item"><span>记录笔数</span><b>${count}</b></div>`;

  const el = $('#exp-list');
  el.innerHTML = d.expenses.length ? '' : '<li class="empty">还没有花钱记录，记一笔吧～</li>';
  [...d.expenses].reverse().forEach((i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="name">${esc(i.item)}</span><span class="meta"> ${i.date}</span></span><span class="val" style="color:#e0413e">${fmt(i.amount)}</span>`;
    li.appendChild(delBtn(d.expenses, i.id));
    el.appendChild(li);
  });

  drawExpChart(groupExpense(d.expenses, state.expPeriod));
}

function groupExpense(arr, period) {
  const map = {};
  arr.forEach((e) => {
    const dte = e.date || '';
    let label = period === 'year' ? dte.slice(0, 4) : dte.slice(0, 7);
    if (!label) label = '未知';
    map[label] = (map[label] || 0) + num(e.amount);
  });
  const labels = Object.keys(map).sort();
  return { labels, data: labels.map((l) => map[l]) };
}

function drawExpChart(g) {
  const axis = state.expPeriod === 'year' ? '年份' : '月份';
  const cfg = {
    type: 'bar',
    data: {
      labels: g.labels,
      datasets: [{ label: '总消费', data: g.data, backgroundColor: '#e0413e', borderRadius: 8, maxBarThickness: 46 }],
    },
    options: baseOpts(axis, '金额'),
  };
  drawChart('exp', 'exp-chart', cfg);
}

function setExpPeriod(p) {
  state.expPeriod = p;
  document.querySelectorAll('#tab-expense .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.p === p));
  drawExpChart(groupExpense(state.data.expenses, p));
}

/* ---------- 图表工具 ---------- */
function baseOpts(xLabel, yLabel) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { font: { size: 13, family: 'IBM Plex Sans' }, color: '#101114' } } },
    scales: {
      x: { title: { display: true, text: xLabel, color: '#686b82' }, ticks: { color: '#686b82', font: { family: 'IBM Plex Sans' } }, grid: { display: false } },
      y: { title: { display: true, text: yLabel, color: '#686b82' }, ticks: { color: '#686b82', font: { family: 'IBM Plex Sans' } }, grid: { color: '#dedee5' }, beginAtZero: true },
    },
  };
}
function drawChart(key, canvasId, cfg) {
  if (charts[key]) charts[key].destroy();
  charts[key] = new Chart(document.getElementById(canvasId), cfg);
}

/* ---------- 增删 ---------- */
function delBtn(arr, id) {
  const b = document.createElement('button');
  b.className = 'del'; b.textContent = '✕';
  b.onclick = () => {
    const i = arr.findIndex((x) => x.id === id);
    if (i >= 0) arr.splice(i, 1);
    saveData(state.data);
    renderAll();
  };
  return b;
}
async function addEarning() {
  const date = $('#earn-date').value;
  const product = $('#earn-product').value.trim();
  const cost = num($('#earn-cost').value);
  const price = num($('#earn-price').value);
  const quantity = num($('#earn-qty').value || '1');
  if (!product || $('#earn-price').value === '') return alert('项目和销售价格要填哦');
  const sales = price * quantity;
  const profit = (price - cost) * quantity;
  state.data.earnings.push({ id: uid(), date, product, cost, price, quantity, sales, profit });
  saveData(state.data);
  $('#earn-product').value = ''; $('#earn-cost').value = ''; $('#earn-price').value = ''; $('#earn-qty').value = '';
  updateEarnPreview();
  renderEarnings();
}
async function addExpense() {
  const item = $('#exp-item').value.trim();
  const amount = $('#exp-amount').value;
  const date = $('#exp-date').value;
  if (!item || amount === '') return alert('项目和金额都要填哦');
  state.data.expenses.push({ id: uid(), item, amount: num(amount), date });
  saveData(state.data);
  $('#exp-item').value = ''; $('#exp-amount').value = '';
  renderExpenses();
}

/* 赚钱实时预览 */
function updateEarnPreview() {
  const cost = num($('#earn-cost').value);
  const price = num($('#earn-price').value);
  const qty = num($('#earn-qty').value);
  const sales = price * qty;
  const profit = (price - cost) * qty;
  $('#earn-preview').textContent = `销售额 ${fmt(sales)} · 盈利 ${fmt(profit)}`;
}
['earn-cost', 'earn-price', 'earn-qty'].forEach((id) => {
  document.addEventListener('input', (e) => { if (e.target && e.target.id === id) updateEarnPreview(); });
});

/* ---------- 工具 ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const todayStr = () => new Date().toISOString().slice(0, 10);

/* ---------- Excel 导出（SheetJS） ---------- */
function exportAssets() {
  if (typeof XLSX === 'undefined') return alert('Excel 库还没加载好，刷新一下试试～');
  const d = state.data;
  const snaps = [...d.snapshots].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const wb = XLSX.utils.book_new();

  /* 现金明细：按日期展开每个现金项目的当日市值 */
  const cashRows = [['日期', '现金项目', '当日市值(¥)']];
  snaps.forEach((s) => {
    if (Array.isArray(s.entries)) s.entries.filter((e) => e.type === 'cash').forEach((e) => cashRows.push([s.date, e.name, num(e.amount)]));
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cashRows), '现金明细');

  /* 基金明细：按日期展开每个基金项目的当日份额+市值 */
  const fundRows = [['日期', '基金项目', '份额', '当日市值(¥)']];
  snaps.forEach((s) => {
    if (Array.isArray(s.entries)) s.entries.filter((e) => e.type === 'fund').forEach((e) => fundRows.push([s.date, e.name, e.shares != null ? num(e.shares) : '', num(e.marketValue)]));
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fundRows), '基金明细');

  /* 资产快照：每日现金/基金合计 + 总资产 */
  const snapRows = [['日期', '现金合计(¥)', '基金合计(¥)', '总资产(¥)']];
  snaps.forEach((s) => { const t = snapTotals(s); snapRows.push([s.date, t.cash, t.fund, t.total]); });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(snapRows), '资产快照');

  XLSX.writeFile(wb, '资产_' + state.username + '_' + todayStr() + '.xlsx');
}
function exportEarnings() {
  if (typeof XLSX === 'undefined') return alert('Excel 库还没加载好，刷新一下试试～');
  const d = state.data;
  const wb = XLSX.utils.book_new();
  const list = [...d.earnings].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const detailAoA = [['日期', '产品/项目', '成本', '单价', '数量', '销售额', '盈利']].concat(list.map((i) => [i.date, i.product, num(i.cost), num(i.price), num(i.quantity), num(i.sales), num(i.profit)]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detailAoA), '赚钱明细');
  const g = groupEarn(d.earnings, state.earnPeriod);
  const axis = state.earnPeriod === 'year' ? '年份' : '月份';
  const aggAoA = [[axis, '总收入', '盈利']].concat(g.labels.map((l, i) => [l, g.sales[i], g.profit[i]]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aggAoA), '汇总');
  XLSX.writeFile(wb, '赚钱_' + state.username + '_' + todayStr() + '.xlsx');
}
function exportExpenses() {
  if (typeof XLSX === 'undefined') return alert('Excel 库还没加载好，刷新一下试试～');
  const d = state.data;
  const wb = XLSX.utils.book_new();
  const list = [...d.expenses].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const detailAoA = [['日期', '项目', '金额']].concat(list.map((i) => [i.date, i.item, num(i.amount)]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detailAoA), '开支明细');
  const g = groupExpense(d.expenses, state.expPeriod);
  const axis = state.expPeriod === 'year' ? '年份' : '月份';
  const aggAoA = [[axis, '总消费']].concat(g.labels.map((l, i) => [l, g.data[i]]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aggAoA), '汇总');
  XLSX.writeFile(wb, '开支_' + state.username + '_' + todayStr() + '.xlsx');
}

/* ---------- 启动 ---------- */
window.switchAuth = switchAuth;
window.doAuth = doAuth;
window.doLogout = doLogout;
window.showTab = showTab;
window.addSnapCash = addSnapCash;
window.addSnapFund = addSnapFund;
window.saveSnapshot = saveSnapshot;
window.onSnapDate = onSnapDate;
window.addEarning = addEarning;
window.addExpense = addExpense;
window.setEarnPeriod = setEarnPeriod;
window.setExpPeriod = setExpPeriod;
window.exportAssets = exportAssets;
window.exportEarnings = exportEarnings;
window.exportExpenses = exportExpenses;

function showTab(name) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + name));
  setTimeout(() => Object.values(charts).forEach((c) => c && c.resize()), 50);
}

if (curUser() && getUsers()[curUser()]) {
  state.username = curUser();
  enterApp();
  syncAfterAuth(state.username); /* 刷新时静默拉云端最新数据 */
} else { switchAuth('login'); }
