const mqtt = require('../../utils/mqtt.min.js');

const UID        = 'YOUR_BAYUN_UID';
const TOPIC      = 'led002';
const TEMP_TOPIC = 'temhum';
const BROKER     = 'wxs://bemfa.com:9504/wss';

// 与固件一致的 BLE UUID
const BLE_SERVICE_UUID = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E';
const BLE_CHAR_DATA_UUID = '6E400002-B5A3-F393-E0A9-E50E24DCCA9E';
const BLE_CHAR_CTRL_UUID = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E';
const BLE_DEVICE_KEYWORD = 'ESP32';   // 按设备名过滤

// 每分钟平均累加器（模块级，不进 data）
let avgAcc = { temp: 0, hum: 0, weight: 0, flow: 0, irtemp: 0, gas: 0, lux: 0, count: 0 };

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

Page({
  data: {
    // 连接方式: mqtt(远程WiFi) / ble(蓝牙)
    mode: 'mqtt',
    connected: false,        // mqtt 已连接云端
    bleStatus: '未连接',     // 未连接 / 扫描中… / 已连接
    bleDeviceName: '',
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
    // ===== 远程通道: MQTT over WSS(巴法云) =====
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
          // 蓝牙模式下收到云端数据只更新界面,不重复累加(避免双通道重复写库)
          this.applySensor(d);
          if (this.data.mode === 'mqtt') this.accSensor(d);
        } catch (e) {
          console.log('传感器数据解析失败', msg);
        }
      }
    });

    this.client.on('close', () => this.setData({ connected: false }));
    this.client.on('error', (e) => console.log('MQTT错误', e));

    // 每 60 秒: 算平均写数据库
    this.avgTimer = setInterval(() => this.saveAvg(), 60000);
    this.loadRecent();

    // 注册 BLE 特征值变化回调(读取结果在这里返回)
    wx.onBLECharacteristicValueChange((res) => this.onBLECharacteristicValueChange(res));
  },

  /* ================= 通道切换 ================= */
  switchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;
    this.setData({ mode });
    if (mode === 'ble') {
      // 进入蓝牙模式: 停止 MQTT 累加,界面等待蓝牙数据
      this.stopBleTimer();
      this.setData({ bleStatus: '未连接', bleDeviceName: '' });
      this.startBleScan();
    } else {
      this.stopBleTimer();
      if (this.bleAdapterOpen) {
        wx.closeBluetoothAdapter({ fail: () => {} });
        this.bleAdapterOpen = false;
      }
    }
  },

  /* ================= 蓝牙通道(BLE) ================= */
  startBleScan() {
    if (this.data.bleStatus === '扫描中…' || this.data.bleStatus === '连接中…') return;
    if (this.bleAdapterOpen) {
      // 适配器已打开,直接扫描
      this.setData({ bleStatus: '扫描中…' });
      this.discoverDevice();
      return;
    }
    this.setData({ bleStatus: '扫描中…' });
    wx.openBluetoothAdapter({
      success: () => {
        this.bleAdapterOpen = true;
        this.discoverDevice();
      },
      fail: (err) => {
        // 适配器其实已打开(重复 open)时,视为已打开继续扫描
        if (err && err.errMsg && err.errMsg.indexOf('already opened') !== -1) {
          this.bleAdapterOpen = true;
          this.discoverDevice();
          return;
        }
        console.error('打开蓝牙适配器失败', err);
        this.setData({ bleStatus: '打开蓝牙失败(请检查手机蓝牙与定位权限)' });
      }
    });
  },

  discoverDevice() {
    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: true,
      success: () => {
        // 周期查一次设备列表,直到找到 ESP32
        const timer = setInterval(() => {
          wx.getBluetoothDevices({
            success: (res) => {
              const target = res.devices.find((d) =>
                (d.name && d.name.indexOf(BLE_DEVICE_KEYWORD) !== -1) ||
                (d.advertisServiceUUIDs && d.advertisServiceUUIDs.indexOf(BLE_SERVICE_UUID) !== -1)
              );
              if (target) {
                clearInterval(timer);
                wx.stopBluetoothDevicesDiscovery({ fail: () => {} });
                this.connectBle(target.deviceId, target.name);
              }
            },
            fail: () => {}
          });
        }, 1500);
        this.discoverTimer = timer;
      },
      fail: (err) => {
        console.error('开始扫描失败', err);
        this.setData({ bleStatus: '扫描失败,请重试' });
      }
    });
  },

  connectBle(deviceId, name) {
    this.setData({ bleStatus: '连接中…', bleDeviceName: name || 'ESP32-Monitor' });
    wx.createBLEConnection({
      deviceId,
      success: () => {
        this.bleDeviceId = deviceId;
        this.prepareBleService(deviceId);
      },
      fail: (err) => {
        console.error('连接失败', err);
        this.setData({ bleStatus: '连接失败,请重试' });
      }
    });
  },

  prepareBleService(deviceId) {
    wx.getBLEDeviceServices({
      deviceId,
      success: (res) => {
        const svc = res.services.find((s) => s.uuid.toUpperCase() === BLE_SERVICE_UUID.toUpperCase());
        if (!svc) {
          this.setData({ bleStatus: '未找到设备服务' });
          return;
        }
        this.bleServiceId = svc.uuid;
        wx.getBLEDeviceCharacteristics({
          deviceId,
          serviceId: svc.uuid,
          success: (r) => {
            const find = (uuid) => {
              const c = r.characteristics.find((x) => x.uuid.toUpperCase() === uuid.toUpperCase());
              return c ? c.uuid : null;
            };
            this.bleCharDataId = find(BLE_CHAR_DATA_UUID);
            this.bleCharCtrlId = find(BLE_CHAR_CTRL_UUID);
            if (!this.bleCharDataId || !this.bleCharCtrlId) {
              this.setData({ bleStatus: '特征值不完整' });
              return;
            }
            // 协商更大 MTU: Android 成功后单次 read 可读 ~253 字节; iOS 系统默认 185 字节
            // (固件 JSON 约 110 字节,两种平台均能一次读完;失败则走 notify/下次重试)
            wx.setBLEMTU({
              deviceId, mtu: 256,
              fail: () => console.warn('setBLEMTU 失败,依赖默认MTU'),
            });
            this.setData({ bleStatus: '已连接', connected: true });
            this.startBleTimer();
            this.readBleData();   // 立即读一次
          },
          fail: (err) => {
            console.error('获取特征失败', err);
            this.setData({ bleStatus: '获取特征失败' });
          }
        });
      },
      fail: (err) => {
        console.error('获取服务失败', err);
        this.setData({ bleStatus: '获取服务失败' });
      }
    });
  },

  startBleTimer() {
    this.stopBleTimer();
    this.bleTimer = setInterval(() => this.readBleData(), 5000);
  },

  stopBleTimer() {
    if (this.bleTimer) { clearInterval(this.bleTimer); this.bleTimer = null; }
    if (this.discoverTimer) { clearInterval(this.discoverTimer); this.discoverTimer = null; }
  },

  readBleData() {
    if (!this.bleDeviceId || !this.bleCharDataId) return;
    wx.readBLECharacteristicValue({
      deviceId: this.bleDeviceId,
      serviceId: this.bleServiceId,
      characteristicId: this.bleCharDataId,
      fail: (err) => console.log('BLE读取失败', err)
    });
  },

  // 特征值变化回调(读取结果在这里拿到)
  onBLECharacteristicValueChange(e) {
    const d = e.detail;
    if (!this.bleDeviceId || d.deviceId !== this.bleDeviceId) return;
    if (d.characteristicId !== this.bleCharDataId) return;
    const hex = d.value;   // ArrayBuffer
    if (!hex || !hex.byteLength) return;
    const bytes = new Uint8Array(hex);
    let msg = '';
    for (let i = 0; i < bytes.length; i++) msg += String.fromCharCode(bytes[i]);
    try {
      const obj = JSON.parse(msg.trim());
      this.applySensor(obj);
      if (this.data.mode === 'ble') this.accSensor(obj);
      console.log('BLE数据', msg);
    } catch (err) {
      console.log('BLE数据解析失败', msg);
    }
  },

  /* ================= 数据与云端(共用) ================= */
  applySensor(d) {
    this.setData({
      temp: d.temp, hum: d.hum,
      weight: d.weight, flow: d.flow, irtemp: d.irtemp,
      gas: d.gas, lux: d.lux
    });
  },

  accSensor(d) {
    avgAcc.temp   += parseFloat(d.temp)   || 0;
    avgAcc.hum    += parseFloat(d.hum)    || 0;
    avgAcc.weight += parseFloat(d.weight) || 0;
    avgAcc.flow   += parseFloat(d.flow)   || 0;
    avgAcc.irtemp += parseFloat(d.irtemp) || 0;
    avgAcc.gas    += parseFloat(d.gas)    || 0;
    avgAcc.lux    += parseFloat(d.lux)    || 0;
    avgAcc.count++;
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
        const list = res.data;  // 时间倒序: 最新一条在最上面
        this.setData({ recentList: list });
      })
      .catch(err => console.error('读取最近数据失败', err));
  },

  /* ================= 最近数据入口 ================= */
  goRecent() {
    wx.navigateTo({ url: '/pages/recent/recent' });
  },

  onToggle(e) {
    const val = e.detail.value;
    if (this.data.mode === 'mqtt') {
      // 远程: 走 MQTT 下发
      this.client.publish(TOPIC, val ? 'on' : 'off', { qos: 1, retain: true });
    } else if (this.data.mode === 'ble') {
      // 蓝牙: 写特征值
      if (!this.bleDeviceId || !this.bleCharCtrlId) {
        wx.showToast({ title: '请先连接蓝牙', icon: 'none' });
        return;
      }
      const buf = new ArrayBuffer(val ? 2 : 3);
      const view = new Uint8Array(buf);
      const s = val ? 'on' : 'off';
      for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i);
      wx.writeBLECharacteristicValue({
        deviceId: this.bleDeviceId,
        serviceId: this.bleServiceId,
        characteristicId: this.bleCharCtrlId,
        value: buf,
        fail: (err) => {
          console.error('BLE写入失败', err);
          wx.showToast({ title: '写入失败', icon: 'none' });
        }
      });
    }
  },

  onUnload() {
    if (this.avgTimer) clearInterval(this.avgTimer);
    this.stopBleTimer();
    if (this.bleAdapterOpen) wx.closeBluetoothAdapter({ fail: () => {} });
    this.client && this.client.end();
  },
});
