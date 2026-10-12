/**
 * MQTT 订阅器 —— 订阅巴法云 temhum 主题,接收 ESP32 数据板的数据
 * 用法: node src/mqttListener.js
 * 这一步先验证"能收到设备数据",落库在下一步接上。
 */
const mqtt = require('mqtt');
const config = require('../config');

const client = mqtt.connect(config.mqtt.url, {
  clientId: config.mqtt.clientId,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
});

client.on('connect', () => {
  console.log('[MQTT] 已连接', config.mqtt.url);
  client.subscribe(config.mqtt.topicData, { qos: 0 }, (err) => {
    if (err) console.error('[MQTT] 订阅失败', err.message);
    else console.log('[MQTT] 已订阅主题:', config.mqtt.topicData);
  });
  client.subscribe(config.mqtt.topicState, { qos: 0 });
});

client.on('message', (topic, payload) => {
  const msg = payload.toString();
  if (topic === config.mqtt.topicData) {
    try {
      const d = JSON.parse(msg);
      console.log('[数据]', new Date().toLocaleTimeString(), JSON.stringify(d));
      // TODO(下一步): 写入数据库 + WebSocket 推送
    } catch (e) {
      console.log('[数据-解析失败]', msg);
    }
  } else if (topic === config.mqtt.topicState) {
    console.log('[回执]', msg);
  }
});

client.on('error', (err) => console.error('[MQTT] 错误', err.message));
client.on('close', () => console.log('[MQTT] 连接关闭,重连中…'));
console.log('正在连接巴法云 MQTT…(确认联网板已开机并连网)');
