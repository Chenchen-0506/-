/*
 * sketch_sep8b —— 数据板(传感器板/从板)
 * 职责: 采集 7 路传感器数据,每 5 秒通过 UART 发给主控板;
 *       接收主控板下发的执行器指令(如 LED:on / LED:off)并执行。
 * 与联网板(sketch_sep24a)配合,板间 UART 协议见文件头注释。
 *
 * 硬件: ESP32-WROOM-32D
 * 板间串口: Serial1  RX=GPIO23  TX=GPIO19  (115200)
 *   本板 TX(19) -> 主控板 RX(16)
 *   主控板 TX(17) -> 本板 RX(23)
 *   两板 GND 必须共地
 *
 * UART 协议:
 *   数据板 -> 主控板(数据帧,每5秒,err=错误码0正常/1称重/2红外/3温湿度/4气体):
 *     {"temp":"22.8","hum":"61.0","weight":"21.9","flow":"0.00","irtemp":"24.4","gas":"311","lux":"172","err":"0"}\n
 *   主控板 -> 数据板(控制帧):
 *     LED:on\n  /  LED:off\n   (可扩展 PUMP:on 等)
 */

#include <DHT.h>
#include <HX711.h>
#include <Adafruit_MLX90614.h>

/* ===== 板间串口(与主控板对接,勿改) ===== */
#define UART_RX_PIN 23
#define UART_TX_PIN 19

/* ===== 执行器 ===== */
const int ledPin = 4;              // 示例执行器: LED(也可接继电器/水泵等)

/* ===== 状态灯(数据板) ===== */
#define LED_POWER 25               // 电源指示,常亮
#define LED_ERR0  26               // 错误码 bit0
#define LED_ERR1  27               // 错误码 bit1
#define LED_ERR2  14               // 错误码 bit2

/* ===== 传感器引脚(沿用原单板工程) ===== */
#define DHTPIN 5
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

#define HX711_DOUT 16
#define HX711_SCK  17
HX711 scale;
float hxOffset = 12524;   // 最初标定(用户计算, 单板真机验证版)
float hxScale  = 422.1;   // 最初标定(用户计算), 单位:克

#define FLOW_PIN 18
volatile unsigned long pulseCount = 0;
float flowRate = 0;

Adafruit_MLX90614 mlx = Adafruit_MLX90614();
bool mlxErr = false;

#define MQ2_PIN   34
#define LIGHT_PIN 32

const unsigned long PUB_INTERVAL = 5000;   // 采集发送周期
unsigned long lastPubMs = 0;
int errorCode = 0;
unsigned long lastErrCheck = 0;
bool dhtFailLast = false;        // 最近一帧 DHT22 是否读取失败
unsigned long bootMs = 0;        // 开机时间戳(MQ-2 预热豁免用)
int gasZeroCount = 0;            // MQ-2 连续读 0 计数(防抖)

void IRAM_ATTR flowISR() {
  pulseCount++;
}

/* 错误检测: 0=正常,1=称重,2=红外,3=温湿度,4=气体(按优先级显示,编号小者优先) */
void checkErrors() {
  if (millis() - lastErrCheck < 500) return;
  lastErrCheck = millis();
  int code = 0;
  if (!scale.wait_ready_timeout(50)) {
    code = 1;                     // 称重超时(轮询式,同之前验证通过的版本)
  } else if (mlxErr) {
    code = 2;                     // 红外未找到
  } else if (dhtFailLast) {
    code = 3;                     // 温湿度读取失败(用最近一帧结果,不重复读)
  } else {
    // 气体: 预热 5 分钟后才检测;连续 3 次(1.5s)读到 0 才报,防误报
    if (millis() > bootMs + 300000UL && analogRead(MQ2_PIN) == 0) {
      if (++gasZeroCount >= 3) code = 4;
    } else {
      gasZeroCount = 0;
    }
  }
  errorCode = code;
}

void updateLeds() {
  // 电源灯: 正常常亮;有故障时 1Hz 闪烁告警
  if (errorCode != 0 && (millis() / 500) % 2 == 0) {
    digitalWrite(LED_POWER, LOW);
  } else {
    digitalWrite(LED_POWER, HIGH);
  }
  // 错误码灯: 1=001(称重) 2=010(红外) 3=011(温湿度) 4=100(气体)
  digitalWrite(LED_ERR0, errorCode & 1);
  digitalWrite(LED_ERR1, errorCode & 2);
  digitalWrite(LED_ERR2, errorCode & 4);
}

float readWeight() {
  if (scale.wait_ready_timeout(300)) {
    float w = scale.get_units(5);   // 换算后重量(克)
    if (w < 0) w = 0;
    return w;
  }
  return 0;
}

/* 采集 + 组装 7 字段 JSON + 通过 UART 发送给主控板 */
void sendFrame() {
  float t  = dht.readTemperature();
  float h  = dht.readHumidity();
  dhtFailLast = isnan(t) || isnan(h);   // 记录本帧温湿度状态(供故障灯判断)
  float w  = readWeight();
  float ir = mlx.readObjectTempC();
  int gas  = analogRead(MQ2_PIN);
  int lux  = analogRead(LIGHT_PIN);

  char payload[220];
  snprintf(payload, sizeof(payload),
    "{\"temp\":\"%.1f\",\"hum\":\"%.1f\",\"weight\":\"%.1f\",\"flow\":\"%.2f\",\"irtemp\":\"%.1f\",\"gas\":\"%d\",\"lux\":\"%d\",\"err\":\"%d\"}",
    t, h, w, flowRate, ir, gas, lux, errorCode);

  Serial1.println(payload);   // 发给主控板
  Serial.print("发送: "); Serial.println(payload);
}

/* 接收主控板控制帧并执行: LED:on / LED:off (可扩展) */
void handleCtrl(String line) {
  line.trim();
  if (line.startsWith("LED:")) {
    String v = line.substring(4);
    v.trim();
    if (v == "on")  digitalWrite(ledPin, HIGH);
    if (v == "off") digitalWrite(ledPin, LOW);
    Serial.print("执行指令: "); Serial.println(line);
  }
  // 扩展示例: PUMP:on / FAN:on 等执行器
}

void readUart() {
  while (Serial1.available()) {
    String line = Serial1.readStringUntil('\n');
    if (line.length() > 0) handleCtrl(line);
  }
}

void setup() {
  Serial.begin(115200);          // 调试串口(USB)
  bootMs = millis();             // 记录开机时间(MQ-2 预热豁免基准)
  Serial1.begin(115200, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);  // 板间 UART

  pinMode(LED_POWER, OUTPUT);
  pinMode(LED_ERR0, OUTPUT);
  pinMode(LED_ERR1, OUTPUT);
  pinMode(LED_ERR2, OUTPUT);
  digitalWrite(LED_POWER, HIGH);
  digitalWrite(LED_ERR0, LOW);
  digitalWrite(LED_ERR1, LOW);
  digitalWrite(LED_ERR2, LOW);

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

  Serial.println("数据板启动, UART1 RX=23 TX=19 @115200");
}

void loop() {
  checkErrors();
  updateLeds();
  readUart();

  if (millis() - lastPubMs >= PUB_INTERVAL) {
    noInterrupts();
    unsigned long pulses = pulseCount;
    pulseCount = 0;
    interrupts();
    float freq = pulses / (PUB_INTERVAL / 1000.0);
    flowRate = freq / 7.5;
    lastPubMs = millis();
    sendFrame();
  }
}
