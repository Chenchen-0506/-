/**
 * 告警引擎 —— 阈值越限 / 传感器故障(错误码) / 设备离线
 * 规则: 同模块同类型未解决告警去重; 数据恢复正常自动标记已解决。
 * 可选微信推送(Server酱·方糖, config.serverChan.key 非空时生效)。
 */
const db = require('./db');
const config = require('../config');

const MODULE_NAMES = {
  temp: '温度', hum: '湿度', weight: '重量', flow: '水流',
  irtemp: '红外体温', gas: '烟雾浓度', lux: '光照', system: '设备',
};
const ERR_MODULES = { 1: ['weight'], 2: ['irtemp'], 3: ['temp', 'hum'], 4: ['gas'] };

function unitOf(key) {
  if (key === 'temp' || key === 'irtemp') return '°C';
  if (key === 'hum') return '%';
  return '';
}

/** 微信推送(Server酱), 失败静默 */
function notify(text) {
  const key = config.serverChan && config.serverChan.key;
  if (!key) return;
  fetch(`https://sctapi.ftqq.com/${key}.send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ title: '【边净牧安】告警', desp: text }).toString(),
  }).catch(() => {});
}

/** 对一条新入库记录做告警检查, 返回新建告警 id 数组 */
function checkAlerts(rec) {
  const created = [];
  // 1) 阈值越限(有阈值配置的模块)
  for (const [key, th] of Object.entries(config.thresholds || {})) {
    const raw = rec[key];
    const v = parseFloat(raw);
    if (raw === undefined || raw === null || isNaN(v)) continue;
    const u = unitOf(key);
    if (v < th.min) {
      const r = db.insertAlert(key, 'danger', 'threshold', `${MODULE_NAMES[key]} ${v}${u} 低于下限 ${th.min}${u}`);
      if (r.created) created.push(r.id);
    } else if (v > th.max) {
      const r = db.insertAlert(key, 'danger', 'threshold', `${MODULE_NAMES[key]} ${v}${u} 超过上限 ${th.max}${u}`);
      if (r.created) created.push(r.id);
    } else {
      db.resolveAlert(key, 'threshold');
    }
  }
  // 2) 传感器故障(错误码)
  const err = parseInt(rec.err) || 0;
  if (err !== 0) {
    for (const m of ERR_MODULES[err] || []) {
      const r = db.insertAlert(m, 'danger', 'err', `${MODULE_NAMES[m]} 传感器故障(错误码 ${err})`);
      if (r.created) created.push(r.id);
    }
  } else {
    for (const ms of Object.values(ERR_MODULES)) {
      for (const m of ms) db.resolveAlert(m, 'err');
    }
  }
  return created;
}

/** 设备在线/离线检查(15 秒无数据判离线), 返回新建告警 id 或 null */
function checkOffline() {
  const latest = db.latest('all');
  const online = !!(latest && Date.now() - latest.time < 15000);
  if (online) {
    db.resolveAlert('system', 'offline');
    return null;
  }
  const r = db.insertAlert('system', 'warning', 'offline', '设备离线(超过15秒未收到数据)');
  return r.created ? r.id : null;
}

module.exports = { checkAlerts, checkOffline, notify };
