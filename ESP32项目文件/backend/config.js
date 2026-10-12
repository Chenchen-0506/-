/**
 * 全局配置 —— 以后迁移云服务器/换数据库只改这个文件
 */
module.exports = {
  /* ===== MQTT(巴法云,与固件/小程序一致) ===== */
  mqtt: {
    url: 'mqtt://bemfa.com:9501',          // 巴法云 MQTT 地址(TCP)
    clientId: 'YOUR_BAYUN_UID',  // 巴法云鉴权: clientId 必须 = UID(私钥)
    topicData: 'temhum',                   // 订阅: 传感器数据主题(ESP32 每5秒发布)
    topicCtrl: 'led002',                   // 发布: 远程控制主题(on/off)
    topicState: 'led002/set',              // 订阅: 设备状态回执
  },

  /* ===== 数据库(开发期 SQLite, 上线切 MySQL 只改这里) ===== */
  db: {
    type: 'sqlite',        // 'sqlite' | 'mysql'
    sqlite: { file: './db/data.db' },
    mysql: {
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: '',
      database: 'pig_monitor',
    },
  },

  /* ===== HTTP / WebSocket ===== */
  http: { port: 3000 },

  /* ===== 登录与权限(JWT, 自实现 HS256, 零依赖) ===== */
  jwt: {
    secret: 'bianjing-muan-2026-local-secret',  // 生产环境务必改成随机长字符串
    expiresIn: 7 * 24 * 3600 * 1000,            // 登录有效期 7 天
  },

  /* ===== 数据保留 ===== */
  retentionDays: 90,    // 超过 N 天的原始数据自动删除(启动时 + 每天 3 点)

  /* ===== 告警阈值(与看板模块告警范围一致) ===== */
  thresholds: {
    temp:   { min: 10, max: 40 },   // °C
    hum:    { min: 20, max: 90 },   // %
    irtemp: { min: 30, max: 40 },   // °C
  },

  /* ===== 微信推送(Server酱·方糖, 可选: 留空则只记录不推送) ===== */
  serverChan: { key: '' },   // 例: 'SCTxxxxxxxxxxxxxxxxxxxx', 去 https://sct.ftqq.com 获取
};
