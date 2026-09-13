# ESP32 物联网远程监控系统（ESP32 + 巴法云 MQTT + 微信小程序）

基于 **ESP32-WROOM-32D**（Arduino 框架）、**巴法云 MQTT**、**微信小程序（云开发）** 的多传感器远程监控系统。设备端采集 6 类传感器数据经 MQTT 上报云端，小程序实时显示并通过 MQTT 下发 LED 控制指令；4 个 LED 组成系统状态指示与故障码指示；小程序每分钟将数据平均后写入云开发数据库。

---

## 一、系统架构

```
┌─────────────┐     MQTT(TCP 9501)     ┌──────────────┐    WSS(9504)     ┌──────────────┐
│ ESP32 设备端  │ ◄───────────────────► │   巴法云     │ ◄──────────────► │  微信小程序    │
│ 6类传感器+LED │                       │  bemfa.com   │                  │  LED 控制+显示 │
└─────────────┘                       └──────────────┘                  └──────────────┘
      │                                        │                                  │
      │                                        │                         wx.cloud 数据库
      │                                  主题: led002 / led002/set / temhum         │
      └──────────────────────────────────────────────► 云开发数据库 sensor_records（每分钟平均记录）
```

- **设备端 → 云端**：每 5 秒向 `temhum` 主题发布 7 字段 JSON（retain）
- **小程序 → 设备**：向 `led002` 发布 `on` / `off`
- **设备 → 小程序（状态回执）**：向 `led002/set` 发布，防止回声循环
- **数据库**：小程序每分钟将收到的数据求平均，写入云开发 `sensor_records` 集合

## 二、引脚分配（全量）

| 模块 | 模块端引脚 | ESP32 GPIO | 供电 | 说明 |
|---|---|---|---|---|
| 被控 LED | 阳极（长脚） | GPIO4 | GPIO 驱动 | 小程序远程开关 |
| DHT22 温湿度 | DATA | GPIO5 | 3.3V/5V | 需 4.7k~10k 上拉 |
| HX711 称重 | DT / SCK | GPIO16 / GPIO17 | 5V | 需标定 offset/scale |
| YF-S201 水流 | 信号输出 | GPIO18 | 5V | 中断脉冲计数 |
| GY-906 红外测温 | SDA / SCL | GPIO21 / GPIO22 | **3.3V** | I2C，地址 0x5A |
| MQ-2 烟雾 | AO | GPIO34 | 5V | ADC1，需预热 |
| TEMT6000 光照 | AO | GPIO32 | 3.3V/5V | ADC1 |
| LED1 运行灯 | 阳极 | GPIO25 | GPIO 驱动 | 常亮=正常 |
| LED2 WiFi 灯 | 阳极 | GPIO26 | GPIO 驱动 | 亮=已连接 |
| LED3 云端灯 | 阳极 | GPIO27 | GPIO 驱动 | 亮=MQTT 已连接 |
| LED4 上报灯 | 阳极 | GPIO14 | GPIO 驱动 | 每 5 秒闪=上报 |

> ⚠️ 所有模块（含外部电源供电的）必须与 ESP32 **共地**；MQ-2/MQ-131 类气体传感器需 5V 供电并预热 5~10 分钟。

## 三、4 LED 状态 / 故障码

| 状态 | LED1(25) | LED2(26) | LED3(27) | LED4(14) |
|---|---|---|---|---|
| 系统正常 | ● 常亮 | ● 亮 | ● 亮 | ○ 每 5 秒闪 |

**故障码**（LED1 闪烁告警，LED2/3/4 亮灭组合，●=1 ○=0）：

| 码 | LED2 | LED3 | LED4 | 含义 | 排查方向 |
|---|---|---|---|---|---|
| 1 | ● | ○ | ○ | WiFi 未连接 | 检查 WiFi 名/密码、路由器 |
| 2 | ○ | ● | ○ | MQTT 云端未连接 | 检查巴法云私钥 UID |
| 3 | ● | ● | ○ | DHT22 读取失败 | 检查 GPIO5 接线/上拉 |
| 4 | ○ | ○ | ● | HX711 无响应 | 检查 GPIO16/17、5V 供电 |
| 5 | ● | ○ | ● | GY-906 红外异常 | 检查 GPIO21/22、3.3V、共地 |
| 6 | ○ | ● | ● | MQ-2 读 0 | 检查 GPIO34 接 AO、5V 供电 |

多个故障同时存在时显示编号最小的。

## 四、数据上报格式（每 5 秒，主题 `temhum`）

```json
{"temp":"24.6","hum":"49.2","weight":"123.4","flow":"0.00","irtemp":"25.1","gas":"345","lux":"1200"}
```

| 字段 | 含义 | 单位 |
|---|---|---|
| temp / hum | DHT22 温度 / 湿度 | ℃ / % |
| weight | HX711 重量 | g（需标定） |
| flow | YF-S201 流速 | L/min（450 脉冲/升 → 频率÷7.5） |
| irtemp | GY-906 红外测温 | ℃ |
| gas | MQ-2 烟雾 ADC 值 | 0~4095 |
| lux | TEMT6000 光照 ADC 值 | 0~4095 |

## 五、数据库平均记录（小程序端）

- 小程序收到每条上报后**累加**（不落库）；
- 每 **60 秒**计算一次平均值，写入云开发数据库集合 **`sensor_records`**；
- 记录字段：`temp/hum/weight/flow/irtemp/gas/lux`（平均值）+ `time`（时间戳）+ `timeStr`（可读时间）；
- 页面"最近数据"读取数据库**最近 5 条**记录显示（满 5 分钟即最近 5 分钟；不足则取已有最近记录）。

> 需先在云开发控制台手动创建集合 `sensor_records`。

## 六、依赖库（Arduino 库管理器安装）

1. **PubSubClient**（MQTT）
2. **DHT sensor library** + **Adafruit Unified Sensor**（DHT22）
3. **HX711 Arduino Library**（Bogdan Necula）
4. **Adafruit MLX90614 Library**（红外）

小程序端：`utils/mqtt.min.js`（MQTT.js v4.2.1 dist 版，官方 npm 包在小程序不兼容）。

## 七、关键配置（改这里）

| 位置 | 参数 |
|---|---|
| 固件 `sketch_sep8b.ino` | `ssid` / `password`（WiFi）、`uid`（巴法云私钥） |
| 小程序 `index.js` | `UID`（巴法云私钥，作 clientId） |
| 小程序 `app.js` | `env`（云开发环境 ID `cloud1-d5gs39jihe019e38b`） |
| 小程序 | 开发调试模式必须勾选"不校验合法域名"（巴法云 9504 非 443 端口，正式域名校验无法通过） |

## 八、文件结构

```
ESP32项目文件/
├── README.md
├── esp32_arduino/
│   └── sketch_sep8b.ino        # 设备端固件（全量：6 传感器 + 4 LED 故障码）
└── miniprogram/                # 微信小程序
    ├── app.js / app.json / app.wxss / sitemap.json
    ├── pages/index/            # 主页面（LED 控制 + 传感器显示 + 最近数据）
    ├── pages/example/          # 云开发模板示例页（保留）
    ├── components/cloudTipModal/
    ├── images/arrow.svg
    └── utils/mqtt.min.js
```

## 九、运行步骤

1. Arduino IDE 安装依赖库，打开 `sketch_sep8b.ino`，填 WiFi/UID，烧录；
2. 串口每 5 秒打印 `上报: {...}`；4 个 LED：3 常亮 + 1 每 5 秒闪 = 正常；
3. 微信开发者工具导入 `miniprogram/`，填 AppID，勾选"不校验合法域名"，编译运行；
4. 云开发控制台创建集合 `sensor_records`，打开小程序运行 1 分钟以上，页面出现"最近数据"，数据库同步累积平均记录。
