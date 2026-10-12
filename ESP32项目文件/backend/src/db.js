/**
 * 数据库层 —— 开发期 SQLite(node:sqlite 内置,零安装)
 * 上线切 MySQL: 1) config.js 改 db.type='mysql'  2) npm i mysql2
 * 表: sensor_records(数据) / settings(配置) / alerts(告警) / users(用户)
 * source: 'mqtt'(巴法云) / 'direct'(直连)
 */
const config = require('../config');

let db = null;

function init() {
  if (config.db.type === 'mysql') {
    // MySQL 模式: 需要 npm i mysql2, 并先在 MySQL 里建库建表(见 db/init.sql)
    throw new Error('MySQL 模式尚未启用: 请先安装 MySQL 并执行 db/init.sql, 然后 npm i mysql2');
  }
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('fs');
  const path = require('path');
  const file = path.resolve(__dirname, '..', config.db.sqlite.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS sensor_records (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    temp     REAL,
    hum      REAL,
    weight   REAL,
    flow     REAL,
    irtemp   REAL,
    gas      INTEGER,
    lux      INTEGER,
    err      INTEGER,
    source   TEXT,
    time     INTEGER,
    time_str TEXT
  )`);
  // 兼容旧库: 已有表但缺 err / source 列时补加
  const cols = db.prepare(`PRAGMA table_info(sensor_records)`).all().map((c) => c.name);
  if (!cols.includes('err')) {
    db.exec(`ALTER TABLE sensor_records ADD COLUMN err INTEGER`);
    console.log('[DB] 已为旧表补加 err 列');
  }
  if (!cols.includes('source')) {
    db.exec(`ALTER TABLE sensor_records ADD COLUMN source TEXT`);
    console.log('[DB] 已为旧表补加 source 列');
  }

  // 查询索引(数据量大后 history/统计不慢)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_time ON sensor_records(time)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_source ON sensor_records(source)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_time_source ON sensor_records(time, source)`);

  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  // 告警表
  db.exec(`CREATE TABLE IF NOT EXISTS alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    module     TEXT NOT NULL,
    level      TEXT NOT NULL,
    type       TEXT NOT NULL,
    text       TEXT NOT NULL,
    start_time INTEGER,
    end_time   INTEGER,
    resolved   INTEGER DEFAULT 0
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(resolved, id)`);

  // 用户表
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'viewer',
    created_at    INTEGER
  )`);

  console.log('[DB] SQLite 就绪:', file);
}

/** 读取配置项(不存在返回默认值) */
function getSetting(key, def = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

/** 写入配置项 */
function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

/** 插入一条记录(source: 'mqtt' | 'direct') */
function insert(rec, source = 'mqtt') {
  const stmt = db.prepare(
    `INSERT INTO sensor_records (temp, hum, weight, flow, irtemp, gas, lux, err, source, time, time_str)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const t = Date.now();
  const err = rec.err === undefined || rec.err === null ? 0 : parseInt(rec.err) || 0;
  stmt.run(
    parseFloat(rec.temp) || 0,
    parseFloat(rec.hum) || 0,
    parseFloat(rec.weight) || 0,
    parseFloat(rec.flow) || 0,
    parseFloat(rec.irtemp) || 0,
    parseInt(rec.gas) || 0,
    parseInt(rec.lux) || 0,
    err,
    source,
    t,
    new Date(t).toLocaleString('zh-CN', { hour12: false })
  );
}

function whereSource(source) {
  return source && source !== 'all' ? ' AND source = ?' : '';
}

/** 最近 limit 条(时间倒序, 最新在上; source 可选 'mqtt'/'direct'/'all') */
function recent(limit = 20, source = 'all') {
  const params = source && source !== 'all' ? [source, limit] : [limit];
  const w = source && source !== 'all' ? 'WHERE source = ?' : '';
  const rows = db.prepare(
    `SELECT temp, hum, weight, flow, irtemp, gas, lux, err, source, time, time_str AS timeStr
     FROM sensor_records ${w} ORDER BY id DESC LIMIT ?`
  ).all(...params);
  return rows;
}

/** 最新一条(按来源取, 默认全部) */
function latest(source = 'all') {
  const rows = recent(1, source);
  return rows.length ? rows[0] : null;
}

/** 最近 minutes 分钟内的历史数据(时间升序, 用于画趋势图; source 可选) */
function history(minutes = 60, limit = 2000, source = 'all') {
  const since = Date.now() - minutes * 60 * 1000;
  const params = source && source !== 'all' ? [since, source, limit] : [since, limit];
  const rows = db.prepare(
    `SELECT temp, hum, weight, flow, irtemp, gas, lux, err, source, time, time_str AS timeStr
     FROM sensor_records WHERE time >= ?${whereSource(source)} ORDER BY id ASC LIMIT ?`
  ).all(...params);
  return rows;
}

/* ================= 告警 ================= */
/** 新告警去重: 同 module+type 已有未解决告警时不重复创建 */
function insertAlert(module, level, type, text) {
  const open = db.prepare('SELECT id FROM alerts WHERE module = ? AND type = ? AND resolved = 0').get(module, type);
  if (open) return { id: Number(open.id), created: false };
  const info = db.prepare(
    'INSERT INTO alerts (module, level, type, text, start_time) VALUES (?, ?, ?, ?, ?)'
  ).run(module, level, type, text, Date.now());
  return { id: Number(info.lastInsertRowid), created: true };
}

function resolveAlert(module, type) {
  db.prepare('UPDATE alerts SET resolved = 1, end_time = ? WHERE module = ? AND type = ? AND resolved = 0')
    .run(Date.now(), module, type);
}

function getAlert(id) {
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
}

/** 告警列表(status: 'open' 未解决 / 'all' 全部) */
function listAlerts(limit = 50, status = 'open') {
  if (status === 'open') {
    return db.prepare('SELECT * FROM alerts WHERE resolved = 0 ORDER BY id DESC LIMIT ?').all(limit);
  }
  return db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT ?').all(limit);
}

/* ================= 统计(日/周聚合) ================= */
function statsDaily(days = 7, source = 'all') {
  const since = Date.now() - days * 24 * 3600 * 1000;
  const params = source !== 'all' ? [since, source, days] : [since, days];
  return db.prepare(
    `SELECT date(time/1000, 'unixepoch', 'localtime') AS day,
       COUNT(*) AS cnt,
       ROUND(AVG(temp),1) AS temp_avg,  ROUND(MAX(temp),1)  AS temp_max,  ROUND(MIN(temp),1)  AS temp_min,
       ROUND(AVG(hum),1)  AS hum_avg,   ROUND(MAX(hum),1)   AS hum_max,   ROUND(MIN(hum),1)   AS hum_min,
       ROUND(AVG(weight),1) AS weight_avg, ROUND(MAX(weight),1) AS weight_max, ROUND(MIN(weight),1) AS weight_min,
       ROUND(AVG(irtemp),1) AS irtemp_avg, ROUND(MAX(irtemp),1) AS irtemp_max, ROUND(MIN(irtemp),1) AS irtemp_min,
       ROUND(AVG(gas),0) AS gas_avg, ROUND(MAX(gas),0) AS gas_max, ROUND(MIN(gas),0) AS gas_min,
       ROUND(AVG(lux),0) AS lux_avg, ROUND(MAX(lux),0) AS lux_max, ROUND(MIN(lux),0) AS lux_min
     FROM sensor_records WHERE time >= ?${whereSource(source)}
     GROUP BY day ORDER BY day DESC LIMIT ?`
  ).all(...params);
}

function statsWeekly(weeks = 4, source = 'all') {
  const since = Date.now() - weeks * 7 * 24 * 3600 * 1000;
  const params = source !== 'all' ? [since, source, weeks] : [since, weeks];
  return db.prepare(
    `SELECT strftime('%Y-W%W', time/1000, 'unixepoch', 'localtime') AS week,
       COUNT(*) AS cnt,
       ROUND(AVG(temp),1) AS temp_avg,  ROUND(MAX(temp),1)  AS temp_max,  ROUND(MIN(temp),1)  AS temp_min,
       ROUND(AVG(hum),1)  AS hum_avg,   ROUND(MAX(hum),1)   AS hum_max,   ROUND(MIN(hum),1)   AS hum_min,
       ROUND(AVG(weight),1) AS weight_avg, ROUND(MAX(weight),1) AS weight_max, ROUND(MIN(weight),1) AS weight_min,
       ROUND(AVG(irtemp),1) AS irtemp_avg, ROUND(MAX(irtemp),1) AS irtemp_max, ROUND(MIN(irtemp),1) AS irtemp_min,
       ROUND(AVG(gas),0) AS gas_avg, ROUND(MAX(gas),0) AS gas_max, ROUND(MIN(gas),0) AS gas_min,
       ROUND(AVG(lux),0) AS lux_avg, ROUND(MAX(lux),0) AS lux_max, ROUND(MIN(lux),0) AS lux_min
     FROM sensor_records WHERE time >= ?${whereSource(source)}
     GROUP BY week ORDER BY week DESC LIMIT ?`
  ).all(...params);
}

/* ================= 数据清理 ================= */
/** 删除 time < ts 的旧数据, 返回删除条数 */
function deleteBefore(ts) {
  return db.prepare('DELETE FROM sensor_records WHERE time < ?').run(ts).changes;
}

/* ================= 用户 ================= */
function userCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}
function createUser(username, passwordHash, role = 'viewer') {
  db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, role, Date.now());
}
function getUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function listUsers() {
  return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all();
}
function updatePassword(username, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(passwordHash, username);
}
function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

module.exports = {
  init, getSetting, setSetting,
  insert, recent, latest, history,
  insertAlert, resolveAlert, getAlert, listAlerts,
  statsDaily, statsWeekly, deleteBefore,
  userCount, createUser, getUser, getUserById, listUsers, updatePassword, deleteUser,
};
