/*
 * sketch_sep24a —— 联网板(主控板/主板)
 * 职责: 通过 UART 接收数据板的数据,统一上云(MQTT)并写入蓝牙(BLE);
 *       接收云端/手机下发的控制指令,转发给数据板执行。
 * 与数据板(sketch_sep8b)配合,板间 UART 协议见文件头注释。
 *
 * 硬件: ESP32-WROOM-32D
 * 板间串口: Serial2  RX=GPIO16  TX=GPIO17  (115200)
 *   本板 RX(16) <- 数据板 TX(19)
 *   本板 TX(17) -> 数据板 RX(23)
 *   两板 GND 必须共地
 *
 * UART 协议:
 *   数据板 -> 本板(数据帧,每5秒):
 *     {"temp":"22.8","hum":"61.0","weight":"21.9","flow":"0.00","irtemp":"24.4","gas":"311","lux":"172"}\n
 *   本板 -> 数据板(控制帧):
 *     LED:on\n  /  LED:off\n
 *
 * 小程序端完全兼容(设备名 ESP32-Monitor / UUID / 7 字段 JSON 均不变)。
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <HTTPClient.h>
#include "esp_wifi.h"

/* ===== WiFi 配置(改成你的) ===== */
const char* ssid     = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";
//const char* ssid     = "Xiaomi_510";
//const char* password = "12345678";

/* ===== MQTT(巴法云,与原单板工程一致) ===== */
const char* uid        = "YOUR_BAYUN_UID";
const char* mqttServer = "bemfa.com";
const int   mqttPort   = 9501;
const char* topic      = "led002";      // 订阅: 云端/手机下发 on/off
const char* stateTopic = "led002/set";  // 回执: 发布 LED 状态
const char* dataTopic  = "temhum";      // 数据: 发布 7 字段 JSON

/* ===== 板间串口(与数据板对接,勿改) ===== */
#define UART_RX_PIN 16
#define UART_TX_PIN 17

/* ===== 后端直连: 电脑上跑的本地后端 =====
 * 直连通道完全由【后端/看板】开关控制("直连通道"开/关, 约 1 分钟内生效),
 * 无需编译开关; 想彻底禁用直连就把 backendUrl 留空即可。
 * backendUrl 改成你电脑的局域网 IP(CMD 里 ipconfig 查看) */
const char* backendUrl = "http://192.168.1.106:3000/api/ingest";
bool directEnabled = true;        // 运行时直连开关(启动与每60秒从后端同步)
unsigned long lastCfgCheck = 0;

/* ===== 状态灯说明 =====
 * 4 个 LED 全部接在【数据板】(GPIO25 电源/故障闪烁, 26/27/14 错误码),
 * 联网板不操作 LED; 本板运行状态通过串口日志与小程序查看。
 */

/* ===== BLE(蓝牙,供小程序近距离直连) ===== */
#define BLE_SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define BLE_CHAR_DATA_UUID "6E400002-B5A3-F393-E0A9-E50E24DCCA9E" // 数据 Read+Notify
#define BLE_CHAR_CTRL_UUID "6E400003-B5A3-F393-E0A9-E50E24DCCA9E" // 控制 Write
#define BLE_DEVICE_NAME "ESP32-Monitor"

BLECharacteristic* pDataChar = NULL;

// 前置声明(供 BLE 回调类调用)
void handleLedCmd(String msg);

class BLEWriteCallback : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) {
    String v = c->getValue();
    String msg = "";
    for (size_t i = 0; i < v.length(); i++) msg += (char)v[i];
    msg.trim();
    handleLedCmd(msg);   // 蓝牙指令走公共处理
  }
};

/* 服务器回调: 断开后自动恢复广播,否则手机断开一次就再也搜不到 */
class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s) {
    Serial.println("BLE 已连接");
  }
  void onDisconnect(BLEServer* s) {
    Serial.println("BLE 已断开,重新广播");
    s->getAdvertising()->start();
  }
};

WiFiClient espClient;
PubSubClient client(espClient);

bool needPublish = false;
String stateToPublish = "";

/* ===== 控制指令公共处理: 云端(MQTT)和手机(BLE)共用 ===== */
/* 执行器在数据板上,这里只负责: 转发给数据板 + 回执状态 */
void handleLedCmd(String msg) {
  Serial.print("指令: ["); Serial.print(msg); Serial.println("]");
  if (msg == "on" || msg == "off") {
    Serial2.print("LED:"); Serial2.println(msg);   // 转发给数据板执行
    stateToPublish = msg;
    needPublish = true;
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int len) {
  String msg = "";
  for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];
  msg.trim();
  handleLedCmd(msg);   // MQTT 指令走公共处理
}

void reconnect() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!client.connected()) {
    if (client.connect(uid)) {
      Serial.println("MQTT 已连接");
      client.subscribe(topic);
    } else {
      Serial.print("MQTT 连接失败 rc="); Serial.println(client.state());
    }
  }
}

/* ===== 从后端同步"直连通道"开关(看板可随时开关, 不阻塞任何通道) ===== */
void checkDirectConfig() {
  if (WiFi.status() != WL_CONNECTED || backendUrl[0] == '\0') return;
  String cfgUrl = String(backendUrl);
  cfgUrl.replace("/api/ingest", "/api/config/direct");
  HTTPClient http;
  http.begin(cfgUrl);
  http.setTimeout(2000);                // 2秒超时, 防止卡住主循环
  int code = http.GET();
  if (code == 200) {
    String body = http.getString();
    int i = body.indexOf("\"enabled\"");
    if (i >= 0) {
      int j = body.indexOf(":", i);
      String v = body.substring(j + 1);
      v.trim();
      directEnabled = v.startsWith("true") || v.startsWith("1");
      Serial.print("[配置] 直连通道 = ");
      Serial.println(directEnabled ? "开启(后端控制)" : "关闭(后端控制)");
    }
  } else if (code > 0) {
    Serial.print("[配置] 查询失败 code="); Serial.println(code);
  }
  http.end();
}

/* ===== 后端直连: HTTP POST 一帧 JSON(失败不影响 MQTT/蓝牙) ===== */
void postBackend(String json) {
  if (backendUrl[0] == '\0') return;   // 未配置地址则跳过
  if (!directEnabled) return;           // 后端开关关闭: 只用巴法云
  HTTPClient http;
  http.begin(backendUrl);
  http.setTimeout(3000);                 // 3秒超时, 防止卡住主循环
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(json);
  if (code == 200) {
    Serial.println("[直连] 已发送到后端");
  } else {
    Serial.print("[直连] 失败 code="); Serial.println(code);
  }
  http.end();
}

/* ===== UART 收到数据板数据帧 ===== */
void handleUartFrame(String json) {
  // 1) 上云: MQTT publish(巴法云, 原通道不变)
  client.publish(dataTopic, json.c_str(), true);
  // 2) 蓝牙: 写特征值 + notify,供小程序读取
  if (pDataChar) {
    pDataChar->setValue(json);
    pDataChar->notify();
  }
  // 3) 直连: HTTP POST 到本地后端(失败不影响上面两条)
  postBackend(json);
  Serial.print("转发上云: "); Serial.println(json);
}

void readUart() {
  while (Serial2.available()) {
    String line = Serial2.readStringUntil('\n');
    if (line.length() > 0) {
      line.trim();
      if (line.startsWith("{")) handleUartFrame(line);
    }
  }
}


void setup() {
  setCpuFrequencyMhz(80);        // 降到80MHz: 整板电流下降~20-30mA(数据量小,性能足够)
  Serial.begin(115200);          // 调试串口(USB)
  Serial2.begin(115200, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);  // 板间 UART

  // BLE 初始化(WiFi 与蓝牙可共存)
  BLEDevice::init(BLE_DEVICE_NAME);
  BLEServer* pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());   // 断开后自动恢复广播
  BLEService* pService = pServer->createService(BLE_SERVICE_UUID);
  pDataChar = pService->createCharacteristic(
    BLE_CHAR_DATA_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  pDataChar->addDescriptor(new BLE2902());
  BLECharacteristic* pCtrlChar = pService->createCharacteristic(
    BLE_CHAR_CTRL_UUID,
    BLECharacteristic::PROPERTY_WRITE);
  pCtrlChar->setCallbacks(new BLEWriteCallback());
  pService->start();
  // 调慢广播间隔: 默认~100ms 很耗电; 600ms 仍能在数秒内被手机发现,功耗大幅下降
  BLEAdvertising* pAdv = pServer->getAdvertising();
  pAdv->setMinInterval(600);
  pAdv->setMaxInterval(600);
  pAdv->start();
  Serial.println("BLE 已启动 (ESP32-Monitor, 广播间隔600ms)");

  // WiFi: 10 秒超时不再等(状态看串口日志/小程序)
  WiFi.begin(ssid, password);
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 10000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi 已连接");
    // 省电优化: modem 间歇休眠 + 发射功率降到13dBm,大幅减小发射电流尖峰
    // (13dBm 在 10 米内足够;距离远/穿墙多可把 52 调回 78 = 默认19.5dBm)
    esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
    esp_wifi_set_max_tx_power(52);
    checkDirectConfig();               // 启动时同步一次后端"直连通道"开关
  } else {
    Serial.println("WiFi 连接超时(10秒)");
  }

  client.setServer(mqttServer, mqttPort);
  client.setCallback(mqttCallback);
  reconnect();

  Serial.println("联网板启动, UART2 RX=16 TX=17 @115200");
}

void loop() {
  if (!client.connected()) {
    reconnect();
  } else {
    client.loop();
  }

  if (needPublish) {
    needPublish = false;
    client.publish(stateTopic, stateToPublish.c_str(), true);
  }

  readUart();   // 接收数据板数据帧,实时上云+写蓝牙

  // 每 60 秒同步一次后端"直连通道"开关(看板改开关后约 1 分钟内生效)
  if (millis() - lastCfgCheck > 60000) {
    lastCfgCheck = millis();
    checkDirectConfig();
  }
}
