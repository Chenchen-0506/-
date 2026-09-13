const mqtt = require('../../utils/mqtt.min.js');

const UID        = '1e777318bfe903005f932efb265d2032';
const TOPIC      = 'led002';
const TEMP_TOPIC = 'temhum';
const BROKER     = 'wxs://bemfa.com:9504/wss';

// 每分钟平均累加器（模块级，不进 data）
let avgAcc = { temp: 0, hum: 0, weight: 0, flow: 0, irtemp: 0, gas: 0, lux: 0, count: 0 };

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

Page({
  data: {
    connected: false,
    ledOn: false,
    temp: '--',
    hum: '--',
    weight: '--',
    flow: '--',
    irtemp: '--',
    gas: '--',
    lux: '--',
    recentList: [],
  },

  onLoad() {
    this.client = mqtt.connect(BROKER, {
      clientId: UID,
      reconnectPeriod: 3000
    });

    this.client.on('connect', () => {
      this.setData({ connected: true });
      this.client.subscribe(TOPIC, { qos: 1 });
      this.client.subscribe(TEMP_TOPIC, { qos: 1 });
      console.log('MQTT 连接成功');
    });

    this.client.on('message', (topic, payload) => {
      const msg = payload.toString();
      console.log('收到', topic, msg);

      if (topic === TOPIC) {
        if (msg === 'on')  this.setData({ ledOn: true });
        if (msg === 'off') this.setData({ ledOn: false });
      } else if (topic === TEMP_TOPIC) {
        try {
          const d = JSON.parse(msg);
          this.setData({
            temp: d.temp, hum: d.hum,
            weight: d.weight, flow: d.flow, irtemp: d.irtemp,
            gas: d.gas, lux: d.lux
          });
          // 累加到每分钟平均值
          avgAcc.temp   += parseFloat(d.temp)   || 0;
          avgAcc.hum    += parseFloat(d.hum)    || 0;
          avgAcc.weight += parseFloat(d.weight) || 0;
          avgAcc.flow   += parseFloat(d.flow)   || 0;
          avgAcc.irtemp += parseFloat(d.irtemp) || 0;
          avgAcc.gas    += parseFloat(d.gas)    || 0;
          avgAcc.lux    += parseFloat(d.lux)    || 0;
          avgAcc.count++;
        } catch (e) {
          console.log('传感器数据解析失败', msg);
        }
      }
    });

    this.client.on('close', () => this.setData({ connected: false }));
    this.client.on('error', (e) => console.log('MQTT错误', e));

    // 每 60 秒：算平均写数据库
    this.avgTimer = setInterval(() => this.saveAvg(), 60000);
    this.loadRecent();
  },

  saveAvg() {
    if (avgAcc.count === 0) return;  // 这一分钟没收到数据就跳过
    const rec = {
      temp:   +(avgAcc.temp   / avgAcc.count).toFixed(1),
      hum:    +(avgAcc.hum    / avgAcc.count).toFixed(1),
      weight: +(avgAcc.weight / avgAcc.count).toFixed(1),
      flow:   +(avgAcc.flow   / avgAcc.count).toFixed(2),
      irtemp: +(avgAcc.irtemp / avgAcc.count).toFixed(1),
      gas:    Math.round(avgAcc.gas   / avgAcc.count),
      lux:    Math.round(avgAcc.lux   / avgAcc.count),
      time:   Date.now(),
      timeStr: fmtTime(Date.now()),
    };
    wx.cloud.database().collection('sensor_records').add({ data: rec })
      .then(res => {
        console.log('已写入平均记录', rec);
        this.loadRecent();   // 写完刷新最近数据
      })
      .catch(err => console.error('写入失败', err));
    avgAcc = { temp: 0, hum: 0, weight: 0, flow: 0, irtemp: 0, gas: 0, lux: 0, count: 0 };
  },

  loadRecent() {
    wx.cloud.database().collection('sensor_records')
      .orderBy('time', 'desc')
      .limit(5)
      .get()
      .then(res => {
        const list = res.data.reverse();  // 倒过来按时间正序显示
        this.setData({ recentList: list });
      })
      .catch(err => console.error('读取最近数据失败', err));
  },

  onToggle(e) {
    this.client.publish(TOPIC, e.detail.value ? 'on' : 'off',
                        { qos: 1, retain: true });
  },

  onUnload() {
    if (this.avgTimer) clearInterval(this.avgTimer);
    this.client && this.client.end();
  },
});
