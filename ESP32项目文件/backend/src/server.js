/**
 * 边净牧安后端服务 —— Express API + WebSocket + MQTT 订阅落库
 * 用法: node src/server.js  (浏览器打开 http://localhost:3000)
 *
 * 权限: 数据查询需登录(JWT); 控制/改配置/管用户需 admin; 设备直连上报(ingest)与
 *       固件查询开关(GET /api/config/direct)保持公开(设备无登录态)。
 */
const path = require('path');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const mqtt = require('mqtt');

const config = require('../config');
const db = require('./db');
const auth = require('./auth');
const alerts = require('./alerts');

/* ================= 数据库 ================= */
db.init();

/* ================= 初始管理员 ================= */
if (db.userCount() === 0) {
  db.createUser('admin', auth.hashPassword('admin123'), 'admin');
  console.log('[认证] 已创建默认管理员: admin / admin123 (登录后请立即修改密码)');
}

/* ================= HTTP ================= */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ---------- 认证 ---------- */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: '请输入用户名和密码' });
  }
  const u = db.getUser(String(username));
  if (!u || !auth.verifyPassword(String(password), u.password_hash)) {
    return res.status(401).json({ ok: false, error: '用户名或密码错误' });
  }
  const token = auth.sign({ userId: u.id, username: u.username, role: u.role });
  res.json({ ok: true, token, user: { username: u.username, role: u.role } });
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({ ok: true, user: { username: req.user.username, role: req.user.role } });
});

// 修改自己的密码 { old, new }
app.post('/api/auth/password', auth.requireAuth, (req, res) => {
  const { old: oldPw, new: newPw } = req.body || {};
  const u = db.getUser(req.user.username);
  if (!u || !auth.verifyPassword(String(oldPw || ''), u.password_hash)) {
    return res.status(400).json({ ok: false, error: '原密码不正确' });
  }
  if (!newPw || String(newPw).length < 6) {
    return res.status(400).json({ ok: false, error: '新密码至少 6 位' });
  }
  db.updatePassword(u.username, auth.hashPassword(String(newPw)));
  res.json({ ok: true });
});

/* ---------- 用户管理(仅 admin) ---------- */
app.get('/api/users', auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({ ok: true, users: db.listUsers() });
});

app.post('/api/users', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: '需要用户名和密码' });
  }
  if (db.getUser(String(username))) {
    return res.status(400).json({ ok: false, error: '用户名已存在' });
  }
  const r = role === 'admin' ? 'admin' : 'viewer';
  db.createUser(String(username), auth.hashPassword(String(password)), r);
  console.log('[用户] 创建', username, '角色', r);
  res.json({ ok: true, users: db.listUsers() });
});

app.delete('/api/users/:id', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const u = db.getUserById(id);
  if (!u) return res.status(404).json({ ok: false, error: '用户不存在' });
  if (u.username === req.user.username) {
    return res.status(400).json({ ok: false, error: '不能删除自己' });
  }
  db.deleteUser(id);
  console.log('[用户] 删除', u.username);
  res.json({ ok: true, users: db.listUsers() });
});

/* ---------- 数据查询(需登录) ---------- */
// 最近 N 条记录(默认 20, 最新在上; ?source=mqtt|direct|all)
app.get('/api/recent', auth.requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const source = req.query.source || 'all';
  res.json(db.recent(limit, source));
});

// 最新一条(?source= 可选)
app.get('/api/latest', auth.requireAuth, (req, res) => {
  const source = req.query.source || 'all';
  res.json(db.latest(source));
});

// 历史数据(画趋势图用): /api/history?minutes=60&limit=2000&source= (兼容旧参数 hours)
app.get('/api/history', auth.requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 2000, 10000);
  const source = req.query.source || 'all';
  let minutes;
  if (req.query.minutes) {
    minutes = Math.min(parseInt(req.query.minutes) || 60, 24 * 7 * 60);
  } else {
    minutes = Math.min(parseInt(req.query.hours) || 1, 24 * 7) * 60;
  }
  res.json(db.history(minutes, limit, source));
});

// 系统状态(看板错误状态栏用)
app.get('/api/status', auth.requireAuth, (req, res) => {
  const latest = db.latest('all');
  const now = Date.now();
  const online = !!(latest && now - latest.time < 15000);   // 15秒内收到数据=在线
  res.json({
    ok: true,
    mqttConnected: mqttClient.connected,
    deviceOnline: online,
    lastDataTime: latest ? latest.time : null,
    lastErr: latest ? (latest.err || 0) : null,
    lastSource: latest ? latest.source : null,
    directEnabled: db.getSetting('directEnabled', 'true') === 'true',
    wsClients: wss.clients.size,
    now,
  });
});

/* ---------- 告警(需登录) ---------- */
app.get('/api/alerts', auth.requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const status = req.query.status === 'all' ? 'all' : 'open';
  res.json(db.listAlerts(limit, status));
});

/* ---------- 统计(需登录) ---------- */
// 日聚合: /api/stats/daily?days=7&source=
app.get('/api/stats/daily', auth.requireAuth, (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 365);
  const source = req.query.source || 'all';
  res.json(db.statsDaily(days, source));
});

// 周聚合: /api/stats/weekly?weeks=4&source=
app.get('/api/stats/weekly', auth.requireAuth, (req, res) => {
  const weeks = Math.min(parseInt(req.query.weeks) || 4, 52);
  const source = req.query.source || 'all';
  res.json(db.statsWeekly(weeks, source));
});

/* ---------- 设备直连(公开: 设备无登录态) ---------- */
// ESP32 HTTP POST 7字段JSON(标记来源 direct)
app.post('/api/ingest', (req, res) => {
  const directEnabled = db.getSetting('directEnabled', 'true') === 'true';
  if (!directEnabled) {
    return res.status(403).json({ ok: false, error: '直连通道已关闭(后端开关)' });
  }
  const d = req.body;
  if (!d || d.temp === undefined || d.hum === undefined) {
    return res.status(400).json({ ok: false, error: '缺少字段' });
  }
  db.insert(d, 'direct');
  const row = db.latest('direct');
  const ids = alerts.checkAlerts(d);
  handleNewAlerts(ids);
  broadcast({ type: 'data', data: row });
  console.log('[直连]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), JSON.stringify(d));
  res.json({ ok: true });
});

// 直连通道开关查询(固件每 60 秒轮询, 公开)
app.get('/api/config/direct', (req, res) => {
  res.json({ ok: true, enabled: db.getSetting('directEnabled', 'true') === 'true' });
});

// 直连通道开关(看板控制, 需 admin)
app.post('/api/config/direct', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const enabled = !!req.body && req.body.enabled === true;
  db.setSetting('directEnabled', enabled ? 'true' : 'false');
  console.log('[配置] 直连通道 =', enabled ? '开启' : '关闭');
  res.json({ ok: true, enabled });
});

// 远程控制(需 admin): { action: "on" | "off" } -> 发布到巴法云 led002
app.post('/api/control', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const action = req.body && req.body.action;
  if (action !== 'on' && action !== 'off') {
    return res.status(400).json({ ok: false, error: 'action 只能是 on/off' });
  }
  mqttClient.publish(config.mqtt.topicCtrl, action, { qos: 1, retain: true });
  console.log('[控制] 已发布', config.mqtt.topicCtrl, '=', action);
  res.json({ ok: true });
});

/* ================= WebSocket 实时推送 ================= */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  console.log('[WS] 前端已连接');
  ws.send(JSON.stringify({ type: 'latest', data: db.latest() }));
  ws.on('close', () => console.log('[WS] 前端断开'));
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

/** 新告警: 实时推送 + 微信通知 */
function handleNewAlerts(ids) {
  if (!ids || !ids.length) return;
  const list = [];
  for (const id of ids) {
    const a = db.getAlert(id);
    if (a) {
      list.push(a);
      broadcast({ type: 'alert', data: a });
    }
  }
  if (list.length) alerts.notify(list.map((a) => `[${a.module}] ${a.text}`).join('\n'));
}

/* ================= MQTT 订阅(巴法云) ================= */
const mqttClient = mqtt.connect(config.mqtt.url, {
  clientId: config.mqtt.clientId,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
});

mqttClient.on('connect', () => {
  console.log('[MQTT] 已连接', config.mqtt.url);
  mqttClient.subscribe(config.mqtt.topicData, { qos: 0 });
  mqttClient.subscribe(config.mqtt.topicState, { qos: 0 });
});

mqttClient.on('message', (topic, payload) => {
  const msg = payload.toString();
  if (topic === config.mqtt.topicData) {
    try {
      const d = JSON.parse(msg);
      db.insert(d, 'mqtt');                       // 来源: 巴法云
      const ids = alerts.checkAlerts(d);
      handleNewAlerts(ids);
      const row = db.latest('mqtt');
      console.log('[数据]', new Date().toLocaleTimeString('zh-CN', { hour12: false }), JSON.stringify(d));
      broadcast({ type: 'data', data: row });
    } catch (e) {
      console.log('[数据-解析失败]', msg);
    }
  } else if (topic === config.mqtt.topicState) {
    console.log('[回执]', msg);
    broadcast({ type: 'state', state: msg });
  }
});

mqttClient.on('error', (err) => console.error('[MQTT] 错误', err.message));
mqttClient.on('close', () => console.log('[MQTT] 连接关闭,重连中…'));

/* ================= 后台任务: 离线告警 / 数据清理 ================= */
// 设备在线状态: 每 15 秒检查, 离线 -> 告警(去重), 恢复 -> 自动解决
setInterval(() => {
  const id = alerts.checkOffline();
  if (id) {
    const a = db.getAlert(id);
    if (a) {
      broadcast({ type: 'alert', data: a });
      alerts.notify(`[设备] ${a.text}`);
    }
  }
}, 15000);

// 数据清理: 启动时 + 每天凌晨 3 点, 删除 retentionDays 天前的数据
function cleanupOld() {
  const before = Date.now() - config.retentionDays * 24 * 3600 * 1000;
  const n = db.deleteBefore(before);
  if (n > 0) console.log(`[清理] 已删除 ${n} 条 ${config.retentionDays} 天前的旧数据`);
}
cleanupOld();
const NEXT_CLEANUP = 3 * 3600 * 1000;   // 每小时对一次表, 到 3 点执行
setInterval(() => {
  const h = new Date().getHours();
  if (h === 3) cleanupOld();
}, 3600 * 1000);

// 数据库备份: 启动时 + 每天 4 点, 保留最近 7 份(存 backend/backup/)
const BACKUP_DIR = path.resolve(__dirname, '..', 'backup');
const BACKUP_KEEP = 7;
function backupDatabase() {
  try {
    const fs = require('fs');
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const src = path.resolve(__dirname, '..', config.db.sqlite.file);
    const d = new Date();
    const p2 = (n) => (n < 10 ? '0' + n : '' + n);
    const name = 'data-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + '.db';
    fs.copyFileSync(src, path.join(BACKUP_DIR, name));
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort();
    while (files.length > BACKUP_KEEP) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    console.log('[备份] 已备份到 ' + name + ' (保留 ' + Math.min(files.length + 1, BACKUP_KEEP) + ' 份)');
  } catch (e) {
    console.log('[备份] 失败: ' + e.message);
  }
}
backupDatabase();
setInterval(() => {
  const h = new Date().getHours();
  if (h === 4) backupDatabase();
}, 3600 * 1000);

/* ================= 启动 ================= */
server.listen(config.http.port, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let lan = '';
  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) {
      if (n.family === 'IPv4' && !n.internal) { lan = n.address; break; }
    }
    if (lan) break;
  }
  console.log('========================================');
  console.log('边净牧安后端已启动');
  console.log('  本机访问:  http://localhost:' + config.http.port);
  console.log('  局域网访问: http://' + (lan || '请用 ipconfig 查询') + ':' + config.http.port + '  (同一 WiFi 下的手机/电脑可用)');
  console.log('  登录账号:  admin / admin123 (首次登录请改密)');
  console.log('  最近数据:  http://localhost:' + config.http.port + '/api/recent?limit=20 (需登录)');
  console.log('  实时推送:  ws://localhost:' + config.http.port + '/ws');
  console.log('========================================');
});
