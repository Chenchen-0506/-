#include <WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <HX711.h>
#include <Adafruit_MLX90614.h>

/* ===== 配置区（改成你的） ===== */
/* ===== 改成你自己的 ===== */
const char* ssid     = "109的星怒WIFI";
const char* password = "202404006";
const char* uid      = "1e777318bfe903005f932efb265d2032";
const int   ledPin   = 4;
/* =============================== */

// ===== 系统状态灯（4 个） =====
#define LED_POWER  25
#define LED_WIFI   26
#define LED_MQTT   27
#define LED_PUB    14
bool     pubBlinkOn = false;
unsigned long pubBlinkStart = 0;
bool     mlxErr = false;

unsigned long lastErrCheck = 0;
int errorCode = 0;

// DHT22 温湿度
#define DHTPIN 5
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

// HX711 称重
#define HX711_DOUT 16
#define HX711_SCK  17
HX711 scale;
float hxOffset = 0;
float hxScale  = 1.0;

// YF-S201 水流
#define FLOW_PIN 18
volatile unsigned long pulseCount = 0;
float flowRate = 0;

// GY-906 红外（I2C：SDA=21, SCL=22）
Adafruit_MLX90614 mlx = Adafruit_MLX90614();

// 模拟传感器
#define MQ2_PIN   34
#define LIGHT_PIN 32

// MQTT
const char* mqttServer = "bemfa.com";
const int   mqttPort   = 9501;
const char* topic      = "led002";
const char* stateTopic = "led002/set";
const char* dataTopic  = "temhum";

WiFiClient espClient;
PubSubClient client(espClient);

bool        needPublish    = false;
const char* stateToPublish = "";
unsigned long lastPubMs = 0;
const unsigned long PUB_INTERVAL = 5000;

void IRAM_ATTR flowISR() {
  pulseCount++;
}

void callback(char* topic, byte* payload, unsigned int len) {
  String msg = "";
  for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];
  msg.trim();
  Serial.print("收到: ["); Serial.print(msg); Serial.println("]");
  if (msg == "on") {
    digitalWrite(ledPin, HIGH);
    stateToPublish = "on";
    needPublish = true;
  } else if (msg == "off") {
    digitalWrite(ledPin, LOW);
    stateToPublish = "off";
    needPublish = true;
  }
}

// ★ 修复1：reconnect 不再死等，连不上就返回，交给故障码显示
void reconnect() {
  if (WiFi.status() != WL_CONNECTED) return;   // WiFi 都没连，跳过
  if (!client.connected()) {
    if (client.connect(uid)) {
      Serial.println("MQTT 已连接");
      client.subscribe(topic);
    } else {
      Serial.print("MQTT 连接失败 rc="); Serial.println(client.state());
    }
  }
}

float readWeight() {
  if (scale.wait_ready_timeout(300)) {
    float w = scale.get_units(5);
    if (w < 0) w = 0;
    return w;
  }
  return 0;
}

void publishAll() {
  float t  = dht.readTemperature();
  float h  = dht.readHumidity();
  float w  = readWeight();
  float ir = mlx.readObjectTempC();
  int gas  = analogRead(MQ2_PIN);
  int lux  = analogRead(LIGHT_PIN);

  char payload[220];
  snprintf(payload, sizeof(payload),
    "{\"temp\":\"%.1f\",\"hum\":\"%.1f\",\"weight\":\"%.1f\",\"flow\":\"%.2f\",\"irtemp\":\"%.1f\",\"gas\":\"%d\",\"lux\":\"%d\"}",
    t, h, w, flowRate, ir, gas, lux);
  client.publish(dataTopic, payload, true);
  Serial.print("上报: "); Serial.println(payload);

  if (errorCode == 0) {
    digitalWrite(LED_PUB, HIGH);
    pubBlinkOn = true;
    pubBlinkStart = millis();
  }
}

void checkErrors() {
  if (millis() - lastErrCheck < 500) return;
  lastErrCheck = millis();

  int code = 0;
  if (WiFi.status() != WL_CONNECTED) {
    code = 1;
  } else if (!client.connected()) {
    code = 2;
  } else if (isnan(dht.readTemperature()) || isnan(dht.readHumidity())) {
    code = 3;
  } else if (!scale.wait_ready_timeout(50)) {
    code = 4;
  } else if (mlxErr) {
    code = 5;
  } else if (analogRead(MQ2_PIN) == 0) {
    code = 6;
  }
  errorCode = code;
}

void updateLeds() {
  if (errorCode == 0) {
    digitalWrite(LED_POWER, HIGH);
    digitalWrite(LED_WIFI, WiFi.status() == WL_CONNECTED ? HIGH : LOW);
    digitalWrite(LED_MQTT, client.connected() ? HIGH : LOW);
  } else {
    digitalWrite(LED_POWER, (millis() / 500) % 2);
    digitalWrite(LED_WIFI,  errorCode & 1);
    digitalWrite(LED_MQTT,  errorCode & 2);
    digitalWrite(LED_PUB,   errorCode & 4);
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(LED_POWER, OUTPUT);
  pinMode(LED_WIFI, OUTPUT);
  pinMode(LED_MQTT, OUTPUT);
  pinMode(LED_PUB, OUTPUT);
  digitalWrite(LED_POWER, HIGH);
  digitalWrite(LED_WIFI, LOW);
  digitalWrite(LED_MQTT, LOW);
  digitalWrite(LED_PUB, LOW);

  pinMode(ledPin, OUTPUT);
  digitalWrite(ledPin, LOW);
  dht.begin();

  scale.begin(HX711_DOUT, HX711_SCK);
  scale.set_offset(hxOffset);
  scale.set_scale(hxScale);

  Wire.begin(21, 22);
  Wire.setClock(100000);
  mlxErr = !mlx.begin();
  if (mlxErr) Serial.println("GY-906 未找到");

  pinMode(FLOW_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_PIN), flowISR, RISING);
  pinMode(MQ2_PIN, INPUT);
  pinMode(LIGHT_PIN, INPUT);

  // ★ 修复2：WiFi 等 10 秒超时就不再等，进 loop 由故障码接管
  WiFi.begin(ssid, password);
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 10000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi 已连接");
    digitalWrite(LED_WIFI, HIGH);
  } else {
    Serial.println("WiFi 连接超时（10秒），进入故障模式");
  }

  client.setServer(mqttServer, mqttPort);
  client.setCallback(callback);
  reconnect();
}

void loop() {
  if (!client.connected()) {
    reconnect();          // 非阻塞，失败不卡
  } else {
    client.loop();
  }

  checkErrors();          // 每 500ms 检测故障
  updateLeds();           // 更新状态灯/故障灯

  if (errorCode == 0 && pubBlinkOn && millis() - pubBlinkStart > 100) {
    digitalWrite(LED_PUB, LOW);
    pubBlinkOn = false;
  }

  if (needPublish) {
    needPublish = false;
    client.publish(stateTopic, stateToPublish, true);
  }

  if (millis() - lastPubMs >= PUB_INTERVAL) {
    noInterrupts();
    unsigned long pulses = pulseCount;
    pulseCount = 0;
    interrupts();
    float freq = pulses / (PUB_INTERVAL / 1000.0);
    flowRate = freq / 7.5;
    lastPubMs = millis();
    publishAll();
  }
}

