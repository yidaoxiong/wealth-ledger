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
function saveData(d) { const u = curUser(); if (u) lsSet(dataKey(u), d); }

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
  const users = getUsers();
  try {
    if (authMode === 'register') {
      if (users[username]) return setMsg('这个用户名已经被注册啦');
      const salt = randSalt();
      users[username] = { salt, hash: await hashPw(password, salt) };
      lsSet(LS_USERS, users);
      lsSet(dataKey(username), emptyData());
    } else {
      const u = users[username];
      if (!u) return setMsg('用户名或密码不对哦');
      if ((await hashPw(password, u.salt)) !== u.hash) return setMsg('用户名或密码不对哦');
    }
    localStorage.setItem(LS_SESSION, username);
    state.username = username;
    enterApp();
  } catch (err) {
    setMsg('出错了：' + (err && err.message ? err.message : err));
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
  renderAll();
}

function renderAll() {
  renderAssets();
  renderEarnings();
  renderExpenses();
}

/* ---------- 资产 ---------- */
function renderAssets() {
  const d = state.data;
  const sumCash = d.cash.reduce((s, i) => s + num(i.amount), 0);
  const sumFund = d.funds.reduce((s, i) => s + num(i.marketValue), 0);
  $('#sum-cash').textContent = fmt(sumCash);
  $('#sum-fund').textContent = fmt(sumFund);
  $('#sum-all').textContent = fmt(sumCash + sumFund);

  const cl = $('#cash-list');
  cl.innerHTML = d.cash.length ? '' : '<li class="empty">还没有现金资产，加一笔吧～</li>';
  d.cash.forEach((i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="name">${esc(i.name)}</span></span><span class="val">${fmt(i.amount)}</span>`;
    li.appendChild(delBtn(d.cash, i.id));
    cl.appendChild(li);
  });

  const fl = $('#fund-list');
  fl.innerHTML = d.funds.length ? '' : '<li class="empty">还没有基金资产，加一笔吧～</li>';
  d.funds.forEach((i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="name">${esc(i.name)}</span><span class="meta"> 份额 ${num(i.shares)} · 市值</span></span><span class="val">${fmt(i.marketValue)}</span>`;
    li.appendChild(delBtn(d.funds, i.id));
    fl.appendChild(li);
  });

  drawAssetChart();
}

function drawAssetChart() {
  const snaps = [...state.data.snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const labels = snaps.map((s) => s.date);
  const cfg = {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '总资产', data: snaps.map((s) => s.total), borderColor: '#7132f5', backgroundColor: 'rgba(113,50,245,0.10)', fill: true, tension: 0.3, borderWidth: 3 },
        { label: '现金', data: snaps.map((s) => s.cash), borderColor: '#5741d8', backgroundColor: 'transparent', tension: 0.3, borderWidth: 2 },
        { label: '基金', data: snaps.map((s) => s.fund), borderColor: '#9497a9', backgroundColor: 'transparent', tension: 0.3, borderWidth: 2 },
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
async function addCash() {
  const name = $('#cash-name').value.trim();
  const amount = $('#cash-amount').value;
  if (!name || amount === '') return alert('项目和金额都要填哦');
  state.data.cash.push({ id: uid(), name, amount: num(amount), updatedAt: Date.now() });
  saveData(state.data);
  $('#cash-name').value = ''; $('#cash-amount').value = '';
  renderAssets();
}
async function addFund() {
  const name = $('#fund-name').value.trim();
  const shares = $('#fund-shares').value;
  const marketValue = $('#fund-value').value;
  if (!name || marketValue === '') return alert('基金名称和市值要填哦');
  state.data.funds.push({ id: uid(), name, shares: num(shares), marketValue: num(marketValue), updatedAt: Date.now() });
  saveData(state.data);
  $('#fund-name').value = ''; $('#fund-shares').value = ''; $('#fund-value').value = '';
  renderAssets();
}
async function takeSnapshot() {
  let date = $('#snap-date').value;
  if (!date) { date = new Date().toISOString().slice(0, 10); $('#snap-date').value = date; }
  const totalCash = state.data.cash.reduce((s, i) => s + num(i.amount), 0);
  const totalFund = state.data.funds.reduce((s, i) => s + num(i.marketValue), 0);
  const total = totalCash + totalFund;
  const snap = state.data.snapshots.find((s) => s.date === date);
  if (snap) { snap.cash = totalCash; snap.fund = totalFund; snap.total = total; }
  else state.data.snapshots.push({ date, cash: totalCash, fund: totalFund, total });
  saveData(state.data);
  alert(date + ' 资产已记录：总共 ' + fmt(total) + '（现金 ' + fmt(totalCash) + ' + 基金 ' + fmt(totalFund) + '）');
  renderAssets();
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

/* ---------- 启动 ---------- */
window.switchAuth = switchAuth;
window.doAuth = doAuth;
window.doLogout = doLogout;
window.showTab = showTab;
window.addCash = addCash;
window.addFund = addFund;
window.takeSnapshot = takeSnapshot;
window.addEarning = addEarning;
window.addExpense = addExpense;
window.setEarnPeriod = setEarnPeriod;
window.setExpPeriod = setExpPeriod;

function showTab(name) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + name));
  setTimeout(() => Object.values(charts).forEach((c) => c && c.resize()), 50);
}

if (curUser() && getUsers()[curUser()]) { state.username = curUser(); enterApp(); }
else { switchAuth('login'); }
