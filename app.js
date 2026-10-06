/* ===== 工单看板系统 - 共享数据层（云端版） =====
   工单存在云数据库里，手机 / 电视 / 电脑看到的是同一份数据，改完自动同步。
   页面代码仍然用同步的 loadOrders() / updateOrders()：
   数据先进内存，写操作立刻生效并后台推送到云端，读写细节全部封在本文件里。 */

const SESSION_KEY = 'gk_session';

/* ===== 云端配置（publicConfig，可以放在前端代码里） ===== */
const CLOUD_ENDPOINT = 'https://gongdan-kanban-10845.app.workbuddy.host';
const CLOUD_PUBLISHABLE_KEY = 'wbpk_zWFLQL2k4fflXuZId6b01G_hjQ7YhfXa0BrR0eZsqgIigrBEK95xjZA';
const TABLE = 'orders';

let db = null;
try {
  if (typeof WorkBuddyCloud !== 'undefined' && WorkBuddyCloud.createWorkBuddyCloud) {
    db = WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: CLOUD_ENDPOINT,
      publishableKey: CLOUD_PUBLISHABLE_KEY
    }).database;
  }
} catch (e) { db = null; }

/* ===== 账号体系 =====
   账号存在云端 users 表：主管账号预置一个，业务员凭固定邀请码自行注册。
   role: staff = 业务员，只能看/管自己的订单；admin = 主管，看全部 */

/* 业务员注册邀请码（固定）。要换码改这一行，然后重新发布即可。 */
const INVITE_CODE = 'GD2026';

const USERS_TABLE = 'users';
const PWD_SALT = 'gk_v1';

/* 密码不存明文：SHA-256(盐 + 密码)。
   非安全上下文（如用 file:// 直接打开）下浏览器不给 crypto.subtle，
   这时降级成明文并打 plain: 标记，登录时按标记分别校验。 */
async function hashPwd(pwd) {
  try {
    const buf = new TextEncoder().encode(PWD_SALT + ':' + pwd);
    const d = await crypto.subtle.digest('SHA-256', buf);
    return 'sha256:' + Array.from(new Uint8Array(d))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    return 'plain:' + pwd;
  }
}

async function checkPwd(pwd, stored) {
  if (!stored) return false;
  if (stored.indexOf('plain:') === 0) return stored === 'plain:' + pwd;
  return (await hashPwd(pwd)) === stored;
}

/* 取账号列表（登录页下拉用，只取姓名和角色，不碰密码） */
async function fetchAccounts() {
  if (!db) throw new Error('云端未连接');
  const res = await db.from(USERS_TABLE).select('name,role');
  if (res.error) throw res.error;
  return res.data || [];
}

/* 登录：校验密码，成功则写入会话 */
async function loginUser(name, pwd) {
  if (!db) return { ok: false, msg: '连不上云端，请检查网络后重试' };
  try {
    const res = await db.from(USERS_TABLE).select('name,pwd,role').eq('name', name);
    if (res.error) throw res.error;
    const u = (res.data || [])[0];
    if (!u) return { ok: false, msg: '没有这个账号，请先用邀请码注册' };
    if (!(await checkPwd(pwd, u.pwd))) return { ok: false, msg: '密码不对' };
    setSession({ name: u.name, role: u.role });
    return { ok: true, session: { name: u.name, role: u.role } };
  } catch (e) {
    return { ok: false, msg: '登录失败：' + ((e && e.message) || e) };
  }
}

/* 注册业务员：必须带正确邀请码，姓名不能重复。注册完直接登录。 */
async function registerUser(name, pwd, invite) {
  if (String(invite || '').trim() !== INVITE_CODE) {
    return { ok: false, msg: '邀请码不对，请向主管确认' };
  }
  if (!db) return { ok: false, msg: '连不上云端，请检查网络后重试' };
  try {
    const dup = await db.from(USERS_TABLE).select('name').eq('name', name);
    if (dup.error) throw dup.error;
    if ((dup.data || []).length) return { ok: false, msg: '这个姓名已被注册，换一个' };
    const res = await db.from(USERS_TABLE).insert({
      name: name, pwd: await hashPwd(pwd), role: 'staff'
    });
    if (res.error) throw res.error;
    setSession({ name: name, role: 'staff' });
    return { ok: true, session: { name: name, role: 'staff' } };
  } catch (e) {
    return { ok: false, msg: '注册失败：' + ((e && e.message) || e) };
  }
}

/* 修改密码：先验原密码 */
async function changePassword(name, oldPwd, newPwd) {
  if (!db) return { ok: false, msg: '连不上云端，请检查网络后重试' };
  try {
    const res = await db.from(USERS_TABLE).select('pwd').eq('name', name);
    if (res.error) throw res.error;
    const u = (res.data || [])[0];
    if (!u) return { ok: false, msg: '账号不存在' };
    if (!(await checkPwd(oldPwd, u.pwd))) return { ok: false, msg: '原密码不对' };
    const up = await db.from(USERS_TABLE).update({ pwd: await hashPwd(newPwd) }).eq('name', name);
    if (up.error) throw up.error;
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: '修改失败：' + ((e && e.message) || e) };
  }
}

function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch (e) { return null; }
}
function setSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
function clearSession() { localStorage.removeItem(SESSION_KEY); }

/* 当前登录人能看到哪些订单：业务员只看自己的，主管看全部 */
function visibleForSession(list, session) {
  if (!session) return [];
  if (session.role === 'admin') return list;
  return list.filter(o => (o.owner || '') === session.name);
}

/* ===== 工单状态 ===== */
const STATUS = {
  todo:  { label: '待处理', color: '#e24b4a' },
  doing: { label: '进行中', color: '#ba7517' },
  done:  { label: '已完成', color: '#3b6d11' }
};

/* 今天日期（YYYY-MM-DD），带天数偏移 */
function today(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ===== 内存数据 + 云端同步 =====
   store.orders   : 页面读到的工单（同步读，页面代码不用改）
   store.versions : id -> 云端 updated_at，用来判断哪几行变了
   store.pending  : 正在推送中的 id，避免被拉回来的旧数据盖掉
   store.listeners: 数据有变化时通知页面重绘 */
const store = {
  orders: [],
  versions: new Map(),
  pending: new Set(),
  listeners: [],
  ready: false,
  started: false,
  lastError: null
};

function loadOrders() { return store.orders; }

/* 数据兼容：把旧版单条 question 迁移成 questions 数组，并补默认字段 */
function normalizeOrder(o) {
  if (o.question && o.question.text) {
    o.questions = [{
      text: o.question.text, at: o.question.at,
      reply: o.question.reply || null, replyAt: null, resolved: false
    }];
    delete o.question;
  }
  if (!Array.isArray(o.questions)) o.questions = [];
  /* 每条疑问可以带图片（拍照/相册）和一条语音，老数据补空 */
  o.questions.forEach(q => {
    if (!Array.isArray(q.images)) q.images = [];
    if (q.audio === undefined) q.audio = null;   /* { u: dataURL, d: 秒 } */
  });
  if (!Array.isArray(o.doneImages)) o.doneImages = [];
  if (o.doneAudio === undefined) o.doneAudio = null;
  /* 业务员上传的文件附件（图纸 / PDF / 文档等原文件），工人端可下载
     每个元素：{ n: 文件名, u: dataURL, s: 字节数, t: 上传时间 } */
  if (!Array.isArray(o.files)) o.files = [];
  /* 点选的常用词（工艺标签）：和手写要求分开存、大屏分开显示
     老订单没有这个字段 → 各端会用 splitNote 从 note 里拆出来兜底 */
  if (!Array.isArray(o.chips)) o.chips = [];
  /* 加急订单：独立于交期的紧急标记，大屏 / 列表 / 手机端都会置顶标红 */
  if (o.rush === undefined) o.rush = false;
  if (!o.owner) o.owner = '未分配';
  return o;
}

/* 附件限制：单文件最大 5MB（dataURL 后约 6.7MB，云端一行 JSONB 装得下，同步也不算慢） */
const FILE_MAX_MB = 5;
const FILE_MAX_COUNT = 5;

function fileSizeLimitBytes() { return FILE_MAX_MB * 1024 * 1024; }

/* 字节数 → 850KB / 2.3MB，附件列表显示用 */
function formatSize(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + 'KB';
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

/* 按扩展名给附件挑个图标 */
function fileIcon(name) {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].indexOf(ext) >= 0) return '🖼️';
  if (ext === 'pdf') return '📕';
  if (['doc', 'docx', 'wps', 'txt', 'rtf'].indexOf(ext) >= 0) return '📄';
  if (['xls', 'xlsx', 'csv'].indexOf(ext) >= 0) return '📊';
  if (['dwg', 'dxf', 'step', 'stp', 'igs', 'iges', 'obj', 'stl', '3dm'].indexOf(ext) >= 0) return '📐';
  if (['zip', 'rar', '7z'].indexOf(ext) >= 0) return '🗜️';
  return '📎';
}

/* 是不是图片类附件（大屏可以直接显示缩略图） */
function isImageFile(name) {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].indexOf(ext) >= 0;
}

/* 触发浏览器下载一个 dataURL 文件（工人端 / 工作台共用） */
function downloadDataFile(name, dataUrl) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name || '附件';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ===== 同步状态提示：一个自动消失的小胶囊，各页面不用各自实现 ===== */
let syncTipEl = null, syncTipTimer = null;
function syncTip(text, isError, hideAfterMs) {
  if (hideAfterMs === null) {          /* 传 null 表示清除 */
    if (syncTipEl) { syncTipEl.remove(); syncTipEl = null; }
    return;
  }
  if (!syncTipEl) {
    syncTipEl = document.createElement('div');
    syncTipEl.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);' +
      'z-index:9999;padding:7px 18px;border-radius:18px;font-size:13px;line-height:1.5;' +
      'font-family:inherit;box-shadow:0 3px 14px rgba(0,0,0,.22);transition:opacity .3s;' +
      'pointer-events:none;max-width:88vw;text-align:center;';
    document.body.appendChild(syncTipEl);
  }
  clearTimeout(syncTipTimer);
  syncTipEl.textContent = text;
  syncTipEl.style.background = isError ? '#a32d2d' : '#2c2c2a';
  syncTipEl.style.color = '#fff';
  syncTipEl.style.opacity = '1';
  if (hideAfterMs) {
    syncTipTimer = setTimeout(function () {
      if (syncTipEl) syncTipEl.style.opacity = '0';
      syncTipTimer = setTimeout(function () {
        if (syncTipEl) { syncTipEl.remove(); syncTipEl = null; }
      }, 350);
    }, hideAfterMs);
  }
}

/* ===== 拉取：先比清单，再按需取内容。没变化就只花一次很小的请求 ===== */
async function pullRemote() {
  if (!db) return false;
  const idx = await db.from(TABLE).select('id,updated_at');
  if (idx.error) throw idx.error;
  const rows = idx.data || [];
  const serverIds = new Set(rows.map(r => r.id));
  const needIds = rows.filter(r => store.versions.get(r.id) !== r.updated_at).map(r => r.id);
  const goneIds = store.orders
    .filter(o => !serverIds.has(o.id) && !store.pending.has(o.id))
    .map(o => o.id);
  if (!needIds.length && !goneIds.length) return false;

  let full = [];
  if (needIds.length) {
    const res = await db.from(TABLE).select('id,payload,updated_at').in('id', needIds);
    if (res.error) throw res.error;
    full = res.data || [];
  }
  mergeRemote(full, goneIds);
  return true;
}

function mergeRemote(rows, goneIds) {
  const byId = new Map(store.orders.map(o => [o.id, o]));
  (goneIds || []).forEach(id => byId.delete(id));
  rows.forEach(r => {
    store.versions.set(r.id, r.updated_at);
    if (store.pending.has(r.id)) return;      /* 本地刚改、还没推完，先以本地为准 */
    const o = normalizeOrder(Object.assign({}, r.payload));
    o.updatedAt = Date.parse(r.updated_at) || o.updatedAt || Date.now();
    byId.set(r.id, o);
  });
  store.orders = Array.from(byId.values());
}

/* ===== 推送队列：写操作本地立刻生效，后台串行推到云端 ===== */
const pushQueue = [];
let pushing = false;

function queueUpsert(o) { pushQueue.push({ type: 'upsert', id: o.id, payload: o }); pump(); }
function queueDelete(id) { pushQueue.push({ type: 'delete', id: id }); pump(); }

async function pump() {
  if (pushing || !db) return;
  pushing = true;
  while (pushQueue.length) {
    const job = pushQueue.shift();
    try {
      if (job.type === 'upsert') {
        store.pending.add(job.id);
        const res = await db.from(TABLE).upsert({ id: job.id, payload: job.payload });
        store.pending.delete(job.id);
        if (res.error) throw res.error;
      } else {
        const res = await db.from(TABLE).delete().eq('id', job.id);
        if (res.error) throw res.error;
      }
      store.versions.delete(job.id);   /* 下次拉取重新确认这一行 */
      store.lastError = null;
    } catch (e) {
      store.pending.delete(job.id);
      store.lastError = (e && e.message) ? e.message : String(e);
      syncTip('同步失败：' + store.lastError, true, 4000);
    }
  }
  pushing = false;
}

/* ===== 对外接口：同步读 / 同步写（页面代码照旧） ===== */
function snapshotOrders() {
  const m = new Map();
  store.orders.forEach(o => m.set(o.id, JSON.stringify(o)));
  return m;
}

function applyOrders(list, before) {
  const afterIds = new Set(list.map(o => o.id));
  store.orders = list;
  before.forEach((json, id) => { if (!afterIds.has(id)) queueDelete(id); });
  list.forEach(o => { if (before.get(o.id) !== JSON.stringify(o)) queueUpsert(o); });
  return !!db;   /* false = 云端没连上，页面据此提示 */
}

function saveOrders(list) { return applyOrders(list, snapshotOrders()); }

function updateOrders(mutator) {
  const before = snapshotOrders();     /* 先快照：mutator 会就地改对象 */
  const list = store.orders.slice();
  mutator(list);
  return applyOrders(list, before);
}

/* ===== 页面启动：等云端数据到齐再渲染，之后每 5 秒拉一次增量 ===== */
function onOrders(cb) { store.listeners.push(cb); }

function notify() {
  store.listeners.forEach(cb => { try { cb(); } catch (e) {} });
}

async function startApp(render) {
  onOrders(render);
  syncTip('正在同步工单…');
  try {
    if (!db) throw new Error('云端 SDK 没加载成功');
    await pullRemote();
    store.ready = true;
    syncTip('已连接云端，数据自动同步', false, 1800);
  } catch (e) {
    store.lastError = (e && e.message) ? e.message : String(e);
    syncTip('连不上云端，请检查网络后刷新页面', true);
  }
  render();
  if (store.started) return;
  store.started = true;
  setInterval(refresh, 5000);
}

async function refresh() {
  if (pushing || !db) return;
  try {
    const changed = await pullRemote();
    if (changed) notify();
    if (store.lastError) { store.lastError = null; syncTip(null); }
  } catch (e) {
    store.lastError = (e && e.message) ? e.message : String(e);
    syncTip('同步失败，正在重试…', true, 2500);
  }
}

/* 清空全部工单（主管用）：云端删干净，其他设备几秒内也会变成空的 */
async function clearAllOrders() {
  if (!db) return false;
  const del = await db.from(TABLE).delete().like('id', '%');
  if (del.error) return false;
  store.orders = [];
  store.versions.clear();
  await pullRemote();
  notify();
  return true;
}

/* 粗算本地存储占用（KB），留作诊断 */
function storageUsageKB() {
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      n += (k ? k.length : 0) + (localStorage.getItem(k) || '').length;
    }
  } catch (e) {}
  return Math.round(n / 1024);
}

/* 订单号生成：编号一旦生成永不变更；这里保证「不重号、不重用」——
   1. 取云端当天已有编号的最大值 +1（按最大值取，而不是按数量取，删过单也不会把旧号发出去）
   2. 生成那一刻实时查一次云端，两台设备先后建单不会拿到同一个号
   3. 云端查不到时退回本地缓存，断网也能建单 */
async function genOrderId() {
  const p = n => String(n).padStart(2, '0');
  const d = new Date();
  const prefix = `GD-${p(d.getMonth() + 1)}${p(d.getDate())}-`;
  let ids = null;
  if (db) {
    try {
      const res = await db.from(TABLE).select('id').like('id', prefix + '%');
      if (!res.error && res.data) ids = res.data.map(r => r.id);
    } catch (e) {}
  }
  if (!ids) ids = loadOrders().filter(o => String(o.id).startsWith(prefix)).map(o => o.id);
  let max = 0;
  ids.forEach(id => {
    const m = String(id).slice(prefix.length).match(/^\d+/);
    if (m) max = Math.max(max, parseInt(m[0], 10));
  });
  const taken = new Set(ids);
  let n = max + 1;
  while (taken.has(prefix + String(n).padStart(3, '0'))) n++;   /* 双保险：候选号被占就顺延 */
  return prefix + String(n).padStart(3, '0');
}

/* 交期换算：剩余多少 / 是否紧急 */
function dueInfo(due, status) {
  if (!due) return { text: '无交期', urgent: false };
  if (status === 'done') return { text: due, urgent: false };
  const d = new Date(due + 'T23:59:59');
  const diff = Math.ceil((d - Date.now()) / 86400000);
  if (diff < 0) return { text: '已逾期', urgent: true };
  if (diff === 0) return { text: '今天到期', urgent: true };
  if (diff === 1) return { text: '明天到期', urgent: true };
  return { text: '还剩 ' + diff + ' 天', urgent: false };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ===== 扫码地址（大屏二维码指向哪里） =====
   项目已发布上线：本机预览（file:// 或 127.0.0.1）时二维码自动指向线上地址，
   手机扫开即用；也可在面板底部手动改成电脑局域网地址。 */
const SCAN_BASE_KEY = 'gk_scan_base';

/* 线上地址 = 云端 endpoint。扫码地址也指向这里：手机只有从线上域名打开，
   云数据库才会认（服务端按域名做来源校验）。 */
const ONLINE_BASE = CLOUD_ENDPOINT + '/';

function currentBase() {
  return location.href.split(/[?#]/)[0].replace(/[^/]*$/, '');
}

/* 是否为本机地址：手机扫码打不开 */
function isLocalBase(base) {
  if (location.protocol === 'file:') return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(base || '');
}

function getScanBase() {
  const saved = localStorage.getItem(SCAN_BASE_KEY);
  /* 忽略无效的手动存档（如 file:/// 本机路径，手机永远扫不开） */
  if (saved && /^https?:\/\//i.test(saved) && !/file:/i.test(saved)) return saved;
  const cur = currentBase();
  return isLocalBase(cur) ? ONLINE_BASE : cur;
}

function setScanBase(v) {
  v = String(v || '').trim();
  if (!v) { localStorage.removeItem(SCAN_BASE_KEY); return ''; }
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  if (v.slice(-1) !== '/') v += '/';
  localStorage.setItem(SCAN_BASE_KEY, v);
  return v;
}

/* ===== 订单快照编解码（base64url，塞进二维码） =====
   手机端本地若没有这条工单，也能立刻看到工单内容并操作 */
function b64uEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return decodeURIComponent(escape(atob(s)));
}

/* 快照越短二维码越稀、越容易扫：制作要求只带前 48 个字（完整要求在大屏上看） */
function encodeSnapshot(o) {
  return b64uEncode(JSON.stringify({
    i: o.id, p: o.product, c: o.customer, q: o.qty, u: o.due,
    s: o.status, w: o.owner || '', n: (o.note || '').slice(0, 48)
  }));
}

function decodeSnapshot(s) {
  if (!s) return null;
  try {
    const x = JSON.parse(b64uDecode(s));
    return {
      id: x.i, product: x.p, customer: x.c, qty: x.q,
      due: x.u, status: x.s, owner: x.w, note: x.n
    };
  } catch (e) { return null; }
}

function feedbackUrl(o) {
  return getScanBase() + 'feedback.html?id=' + encodeURIComponent(o.id) +
    '&d=' + encodeSnapshot(o);
}

/* ===== 时间显示 ===== */
function timeAgo(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* 精确到秒（只用在推送文案里）——
   PushPlus 对「完全相同的内容」限制 1 小时 3 条，精确到秒可避免两条消息被误判重复 */
function fmtTimeSec(ts) {
  if (!ts) return '';
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* ===== 图片上传：压到 900px 内的 JPEG，防止 localStorage 爆掉 =====
   opt.max / opt.quality 可覆盖默认压缩档（反馈附图用更小的档省空间） */
function compressImage(file, cb, opt) {
  opt = opt || {};
  const max = opt.max || 900;
  const quality = opt.quality || 0.72;
  const reader = new FileReader();
  reader.onload = function (e) {
    const img = new Image();
    img.onload = function () {
      let w = img.width, h = img.height;
      if (w > max || h > max) {
        const r = max / Math.max(w, h);
        w = Math.round(w * r); h = Math.round(h * r);
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(c.toDataURL('image/jpeg', quality));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

/* ===== 语音留言工具 ===== */
const REC_MAX_SEC = 60;   /* 单条语音最长 60 秒，防止本地存储被一条占满 */

/* 浏览器是否支持录音（微信内置浏览器需 iOS 14.3+ / 较新版安卓微信） */
function recorderSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
    typeof window.MediaRecorder === 'function');
}

/* 挑一个当前浏览器支持、且录完能回放的音频格式：
   Chrome/安卓微信 → webm/opus；iOS Safari → mp4。
   注意顺序：iOS 不支持 webm，会自动落到 mp4。 */
function pickAudioMime() {
  if (typeof window.MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (let i = 0; i < cands.length; i++) {
    try { if (MediaRecorder.isTypeSupported(cands[i])) return cands[i]; } catch (e) {}
  }
  return '';
}

function blobToDataURL(blob, cb) {
  const r = new FileReader();
  r.onload = e => cb(e.target.result);
  r.readAsDataURL(blob);
}

/* 秒数 → 12" / 1'05" */
function fmtDur(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  if (sec < 60) return sec + '"';
  const p = n => String(n).padStart(2, '0');
  return Math.floor(sec / 60) + "'" + p(sec % 60) + '"';
}

/* ============================================================
   通知：工人提疑问 / 点完工时，第一时间告诉业务员
   ------------------------------------------------------------
   三条通道各自独立、可任意组合，配置存在云端 settings 表，所有设备共用：
     1) 个人微信（PushPlus / Server酱 中转）
        微信官方没有开放「给某个个人微信发消息」的接口，唯一可行路子是
        走服务号模板消息 —— PushPlus、Server酱 就是干这个的：微信扫码绑定后
        拿到一个 key，消息以服务号消息的形式出现在微信里。
     2) 企业微信群机器人 Webhook：消息发到群里，多人可见。
     3) 电脑桌面提醒：业务员开着工作台时弹系统通知 + 响铃，本机开关、零配置。

   推送由工人手机端触发（提交疑问 / 点完成那一刻），
   这样业务员就算没开电脑，微信里照样能收到。
   ============================================================ */

const SETTINGS_TABLE = 'settings';
const SETTINGS_NOTIFY_KEY = 'notify';
const DESKTOP_KEY = 'gk_desktop_notify';
const SEEN_EVENTS_KEY = 'gk_seen_events';

let notifySettings = null;   /* 云端拉回来的通知配置，缓存在内存 */

async function loadNotifySettings() {
  if (!db) return {};
  try {
    const res = await db.from(SETTINGS_TABLE).select('key,value').eq('key', SETTINGS_NOTIFY_KEY);
    if (res.error) throw res.error;
    const row = (res.data || [])[0];
    if (row && row.value) notifySettings = row.value;
  } catch (e) { /* 拉不到就先用空的，不影响工单主流程 */ }
  return notifySettings || {};
}

async function saveNotifySettings(cfg) {
  if (!db) return false;
  try {
    const res = await db.from(SETTINGS_TABLE).upsert({ key: SETTINGS_NOTIFY_KEY, value: cfg });
    if (res.error) throw res.error;
    notifySettings = cfg;
    return true;
  } catch (e) {
    return false;
  }
}

/* 通用设置读写：一个 key 存一条 JSON（'notify'=通知配置，'note_chips'=制作要求常用词） */
async function loadSetting(key) {
  if (!db) return null;
  try {
    const res = await db.from(SETTINGS_TABLE).select('key,value').eq('key', key);
    if (res.error) throw res.error;
    const row = (res.data || [])[0];
    return row ? (row.value || null) : null;
  } catch (e) { return null; }
}

async function saveSetting(key, value) {
  if (!db) return false;
  try {
    const res = await db.from(SETTINGS_TABLE).upsert({ key, value });
    if (res.error) throw res.error;
    return true;
  } catch (e) { return false; }
}

/* ===== 制作要求：常用词高亮成气泡（大屏 / 工人端共用） =====
   常用词表在工作台里维护、存在 settings 表，这里只读；读不到就退回纯文字显示 */
const NOTE_CHIPS_KEY = 'note_chips';
let noteChipWords = [];

async function loadNoteChips() {
  const v = await loadSetting(NOTE_CHIPS_KEY);
  noteChipWords = (Array.isArray(v) ? v : []).filter(function (w) {
    return w && String(w).trim();
  });
  return noteChipWords;
}

/* 把制作要求拆成「常用词（做气泡）」+「手写文字」；
   对不上常用词的片段原样保留，一个字都不丢。
   words 可选：不传就用云端常用词表（老订单没有独立 chips 字段时用它兜底拆分） */
function splitNote(note, words) {
  const list = Array.isArray(words) ? words : noteChipWords;
  const raw = String(note == null ? '' : note).trim();
  if (!raw) return { chips: [], text: '' };
  if (!list.length) return { chips: [], text: raw };
  const chips = [], rest = [];
  raw.split(/[、，,；;\/\n\r|｜]+/).forEach(function (p) {
    const s = p.trim();
    if (!s) return;
    if (list.indexOf(s) >= 0) { if (chips.indexOf(s) < 0) chips.push(s); }
    else rest.push(s);
  });
  return { chips: chips, text: rest.join('、') };
}

function notifyChannels() {
  const c = notifySettings || {};
  return {
    pushplus: String(c.pushplus || '').trim(),
    serverchan: String(c.serverchan || '').trim(),
    wecom: String(c.wecom || '').trim()
  };
}

function hasAnyChannel() {
  const c = notifyChannels();
  return !!(c.pushplus || c.serverchan || c.wecom);
}

/* ---- 个人微信：PushPlus。GET 接口，实测浏览器可直接跨域调用并读到返回 ---- */
async function sendPushPlus(token, title, content) {
  try {
    const url = 'https://www.pushplus.plus/send?token=' + encodeURIComponent(token) +
      '&title=' + encodeURIComponent(title) + '&content=' + encodeURIComponent(content) +
      '&template=txt';
    const r = await fetch(url);
    const j = await r.json();
    if (j && j.code === 200) return { ok: true };
    return { ok: false, msg: (j && (j.msg || j.data)) || ('HTTP ' + r.status) };
  } catch (e) {
    return { ok: false, msg: '网络错误：' + ((e && e.message) || e) };
  }
}

/* ---- 个人微信：Server酱。同样是 GET，code=0 表示成功 ---- */
async function sendServerChan(key, title, content) {
  try {
    const url = 'https://sctapi.ftqq.com/' + encodeURIComponent(key) + '.send?title=' +
      encodeURIComponent(title) + '&desp=' + encodeURIComponent(content);
    const r = await fetch(url);
    const j = await r.json();
    if (j && (j.code === 0 || j.data)) return { ok: true };
    return { ok: false, msg: (j && (j.message || j.info)) || ('HTTP ' + r.status) };
  } catch (e) {
    return { ok: false, msg: '网络错误：' + ((e && e.message) || e) };
  }
}

/* ---- 企业微信群机器人：只能 POST。
   浏览器直连会被跨域拦掉，所以用 no-cors + text/plain 把请求送出去 ——
   代价是拿不到回执，成功与否无法从前端确认。 ---- */
async function sendWecom(webhook, content) {
  try {
    await fetch(webhook, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ msgtype: 'text', text: { content: content } })
    });
    return { ok: true, uncertain: true };
  } catch (e) {
    return { ok: false, msg: '网络错误：' + ((e && e.message) || e) };
  }
}

/* ============================================================
   发送节流队列
   ------------------------------------------------------------
   PushPlus 免费版硬限制：1 分钟最多 5 次请求，超出后直接静默丢弃
   （不返回 429，也不告诉你为什么）。多人同时点完成/提问就会踩到。
   策略：额度够就立刻发（绝大多数情况，工人关掉页面也不受影响）；
   额度用满就排队，由定时器在窗口滑过后自动补发。
   ============================================================ */
const RATE_LIMIT = {
  pushplus:   { max: 5,  win: 60000, label: '个人微信 PushPlus' },
  serverchan: { max: 5,  win: 60000, label: '个人微信 Server酱' },
  wecom:      { max: 20, win: 60000, label: '企业微信群' }
};
const QUEUE_MAX = 50;          /* 极端情况下上限，超出丢最旧的，避免内存无限堆积 */

const sendLog = { pushplus: [], serverchan: [], wecom: [] };   /* 各通道最近发送时间戳 */
let sendQueue = [];            /* 等待补发的任务 */
let queueTimer = null;

/* 只保留窗口内的记录，返回之 */
function recentSends(ch) {
  const lim = RATE_LIMIT[ch];
  const now = Date.now();
  sendLog[ch] = (sendLog[ch] || []).filter(t => now - t < lim.win);
  return sendLog[ch];
}

/* 还要等多少毫秒才能再发一条（0 = 现在就能发） */
function waitForSlot(ch) {
  const lim = RATE_LIMIT[ch];
  const arr = recentSends(ch);
  if (arr.length < lim.max) return 0;
  return Math.max(0, lim.win - (Date.now() - arr[0]) + 80);
}

function markSent(ch) {
  sendLog[ch] = recentSends(ch).concat(Date.now());
}

/* 按通道分发一条真实请求 */
function dispatchOne(job) {
  if (job.ch === 'pushplus') return sendPushPlus(job.token, job.title, job.content);
  if (job.ch === 'serverchan') return sendServerChan(job.token, job.title, job.content);
  return sendWecom(job.token, job.title + '\n' + job.content);
}

function pumpQueue() {
  for (let i = 0; i < sendQueue.length; i++) {
    const job = sendQueue[i];
    if (waitForSlot(job.ch) === 0) {
      sendQueue.splice(i, 1);
      i--;
      markSent(job.ch);
      dispatchOne(job).catch(() => {});   /* 补发失败也不重试：避免把额度耗在旧消息上 */
    }
  }
  if (!sendQueue.length) stopQueueTimer();
}

function startQueueTimer() {
  if (queueTimer) return;
  queueTimer = setInterval(pumpQueue, 1500);
}

function stopQueueTimer() {
  if (queueTimer) { clearInterval(queueTimer); queueTimer = null; }
}

/* 队列里还压着几条（设置面板显示用） */
function noticeQueueSize() { return sendQueue.length; }

/* 入队或立即发送。返回状态对象，不等待实际结果，调用方不必挂起 */
function enqueueNotice(ch, token, title, content) {
  const lim = RATE_LIMIT[ch];
  if (!lim || !token) return { ch: ch, ok: true, skipped: true };

  if (waitForSlot(ch) === 0) {
    markSent(ch);
    dispatchOne({ ch: ch, token: token, title: title, content: content }).catch(() => {});
    return { ch: lim.label, ok: true, sent: true };
  }

  if (sendQueue.length >= QUEUE_MAX) sendQueue.shift();
  sendQueue.push({ ch: ch, token: token, title: title, content: content, at: Date.now() });
  startQueueTimer();
  return {
    ch: lim.label, ok: true, queued: true,
    wait: waitForSlot(ch), queue: sendQueue.length
  };
}

/* 往所有已配置的通道各发一份（不等待，避免排队时把调用方挂住） */
async function sendAllChannels(title, content) {
  const c = notifyChannels();
  const out = [];
  if (c.pushplus) out.push(enqueueNotice('pushplus', c.pushplus, title, content));
  if (c.serverchan) out.push(enqueueNotice('serverchan', c.serverchan, title, content));
  if (c.wecom) out.push(enqueueNotice('wecom', c.wecom, title, content));
  return out;
}

/* 组装通知文案 */
function buildEventMessage(kind, order, extra) {
  const who = order.owner || '未分配';
  const rushTag = order.rush ? '加急·' : '';
  const base = [
    '业务员：' + who,
    '产品：' + (order.product || '—') + '（数量 ' + (order.qty || '—') + '）',
    '客户：' + (order.customer || '—')
  ];
  if (order.rush) base.push('⚡ 这是加急订单');

  if (kind === 'question') {
    const q = (extra && extra.question) || {};
    const bits = [];
    if ((q.images || []).length) bits.push(q.images.length + ' 张图');
    if (q.audio && q.audio.d) bits.push('语音 ' + fmtDur(q.audio.d));
    return {
      title: '【' + rushTag + '工单疑问】' + order.id + '（' + who + '）',
      content: base.concat([
        '疑问：' + (q.text || '（未写文字，请看附件）'),
        bits.length ? '附件：' + bits.join(' / ') : '',
        '时间：' + fmtTimeSec(q.at || Date.now()),
        '',
        '回复地址：' + currentBase() + 'admin.html'
      ]).filter(Boolean).join('\n')
    };
  }

  const bits = [];
  if ((order.doneImages || []).length) bits.push(order.doneImages.length + ' 张完工图');
  if (order.doneAudio && order.doneAudio.d) bits.push('完工语音 ' + fmtDur(order.doneAudio.d));
  return {
    title: '【' + rushTag + '工单完工】' + order.id + '（' + who + '）',
    content: base.concat([
      bits.length ? '反馈：' + bits.join(' / ') : '',
      '时间：' + fmtTimeSec(order.doneAt || Date.now()),
      '',
      '查看地址：' + currentBase() + 'admin.html'
    ]).filter(Boolean).join('\n')
  };
}

/* 对外：工人端提交后调用。发不出去也不影响主流程，所以错误全部吞掉 */
async function notifyOrderEvent(kind, orderId, extra) {
  try {
    if (!hasAnyChannel()) return [];
    if (!notifySettings) await loadNotifySettings();
    if (!hasAnyChannel()) return [];
    const order = store.orders.find(o => o.id === orderId);
    if (!order) return [];
    const m = buildEventMessage(kind, order, extra);
    return await sendAllChannels(m.title, m.content);
  } catch (e) {
    return [];
  }
}

/* 设置页的「发送测试」用：用还没保存的输入值直接试 */
async function testNotifyChannels(cfg) {
  const c = {
    pushplus: String((cfg && cfg.pushplus) || '').trim(),
    serverchan: String((cfg && cfg.serverchan) || '').trim(),
    wecom: String((cfg && cfg.wecom) || '').trim()
  };
  if (!c.pushplus && !c.serverchan && !c.wecom) {
    return [{ ch: '未配置', ok: false, msg: '先填一个推送地址再测' }];
  }
  const title = '【测试】工单看板通知已接通';
  const content = '看到这条消息就说明通知链路是通的。\n时间：' + fmtTimeSec(Date.now());
  const jobs = [];
  if (c.pushplus) jobs.push(['pushplus', c.pushplus, '个人微信 PushPlus']);
  if (c.serverchan) jobs.push(['serverchan', c.serverchan, '个人微信 Server酱']);
  if (c.wecom) jobs.push(['wecom', c.wecom, '企业微信群']);

  const out = [];
  for (let i = 0; i < jobs.length; i++) {
    const ch = jobs[i][0], token = jobs[i][1], label = jobs[i][2];
    const wait = waitForSlot(ch);
    if (wait > 0) {
      /* 本分钟额度已满：入队并如实告知，而不是假装成功或直接失败 */
      enqueueNotice(ch, token, title, content);
      out.push({
        ch: label, ok: true, queued: true,
        msg: '本分钟 ' + RATE_LIMIT[ch].max + ' 条额度已用完，本条已排队，约 ' +
          Math.ceil(wait / 1000) + ' 秒后自动发出'
      });
      continue;
    }
    markSent(ch);
    const r = await dispatchOne({ ch: ch, token: token, title: title, content: content });
    out.push(Object.assign({ ch: label }, r));
  }
  return out;
}

/* ===== 电脑桌面提醒（业务员端，本机开关，不需要任何配置） ===== */
function desktopNotifyOn() {
  try { return localStorage.getItem(DESKTOP_KEY) === '1'; }
  catch (e) { return false; }
}
function setDesktopNotify(on) {
  try { localStorage.setItem(DESKTOP_KEY, on ? '1' : '0'); } catch (e) {}
}
function desktopNotifySupported() {
  return typeof window.Notification !== 'undefined';
}
function desktopNotifyPermission() {
  if (!desktopNotifySupported()) return 'unsupported';
  return Notification.permission;
}
async function askDesktopNotifyPermission() {
  if (!desktopNotifySupported()) return 'unsupported';
  try { return await Notification.requestPermission(); }
  catch (e) { return Notification.permission; }
}

/* 提示音：不用音频文件，Web Audio 现场合成两声短音，避免多一个网络请求 */
let notifyAudioCtx = null;
function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!notifyAudioCtx) notifyAudioCtx = new AC();
    if (notifyAudioCtx.state === 'suspended') notifyAudioCtx.resume();
    const t0 = notifyAudioCtx.currentTime;
    [[0, 784], [0.2, 1047]].forEach(function (p) {
      const o = notifyAudioCtx.createOscillator(), g = notifyAudioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = p[1];
      g.gain.setValueAtTime(0.0001, t0 + p[0]);
      g.gain.exponentialRampToValueAtTime(0.3, t0 + p[0] + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + p[0] + 0.16);
      o.connect(g);
      g.connect(notifyAudioCtx.destination);
      o.start(t0 + p[0]);
      o.stop(t0 + p[0] + 0.18);
    });
  } catch (e) {}
}

function showDesktopNotice(title, body) {
  if (!desktopNotifyOn()) return;
  if (desktopNotifyPermission() !== 'granted') return;
  beep();
  try {
    const n = new Notification(title, {
      body: body, tag: title + '|' + body, requireInteraction: true
    });
    n.onclick = function () { try { window.focus(); n.close(); } catch (e) {} };
    setTimeout(function () { try { n.close(); } catch (e) {} }, 20000);
  } catch (e) {}
}

/* ===== 新事件检测：业务员端据此弹桌面提醒 =====
   把「提了疑问」「完工了」做成指纹，跟上次已见的比对，新出现的才提醒。
   第一次运行只记录不弹，否则一打开就把历史事件全弹一遍。 */
function orderEventList(list) {
  const out = [];
  list.forEach(function (o) {
    (o.questions || []).forEach(function (q, i) {
      const has = q.text || (q.images || []).length || q.audio;
      if (!has) return;
      out.push({ fp: o.id + '#q' + i + '@' + (q.at || 0), kind: 'question', order: o, question: q });
    });
    if (o.doneAt) out.push({ fp: o.id + '#done@' + o.doneAt, kind: 'done', order: o });
  });
  return out;
}

function takeNewEvents(list) {
  const all = orderEventList(list);
  let seen = new Set(), firstRun = false;
  try {
    const raw = localStorage.getItem(SEEN_EVENTS_KEY);
    firstRun = !raw;
    seen = new Set(JSON.parse(raw || '[]'));
  } catch (e) { firstRun = true; }
  const fresh = firstRun ? [] : all.filter(function (e) { return !seen.has(e.fp); });
  try {
    localStorage.setItem(SEEN_EVENTS_KEY, JSON.stringify(all.map(e => e.fp).slice(-500)));
  } catch (e) {}
  return fresh;
}

/* 标题栏未读角标 */
let unreadCount = 0;
let baseTitle = '';
function paintUnread() {
  if (!baseTitle) baseTitle = document.title.replace(/^（\d+）/, '');
  document.title = unreadCount ? '（' + unreadCount + '）' + baseTitle : baseTitle;
}
function bumpUnread(n) { unreadCount = Math.max(0, unreadCount + (n || 1)); paintUnread(); }
function clearUnread() { unreadCount = 0; paintUnread(); }
