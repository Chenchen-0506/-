<template>
  <div v-if="!token" class="login-page">
    <div class="login-box">
      <h2>边净牧安 · 后台登录</h2>
      <div class="sub" style="text-align:center;">ESP32 猪舍监测 · 本地后端</div>
      <el-input v-model="loginForm.username" placeholder="用户名" size="large" />
      <el-input v-model="loginForm.password" type="password" placeholder="密码" size="large" show-password @keyup.enter="doLogin" />
      <el-button type="primary" size="large" :loading="loginLoading" @click="doLogin">登 录</el-button>
      <div v-if="loginErr" class="login-err">{{ loginErr }}</div>
    </div>
  </div>
  <div v-else class="page">
    <header class="top">
      <div>
        <h1>边净牧安 · 猪舍监测后台</h1>
        <div class="sub">ESP32 → 巴法云/直连 → 本后端 → 实时展示</div>
      </div>
      <div class="status">
        <el-select v-model="srcFilter" size="small" style="width:150px;margin-right:10px;" @change="onSrcChange">
          <el-option label="数据源: 全部" value="all" />
          <el-option label="数据源: 直连设备" value="direct" />
          <el-option label="数据源: 巴法云" value="mqtt" />
        </el-select>
        <span v-if="user" class="user">{{ user.username }}<span class="u-role">{{ user.role === 'admin' ? '管理员' : '只读' }}</span></span>
        <el-button v-if="user" size="small" text @click="logout">退出</el-button>
        <el-tag :type="connOk ? 'success' : 'danger'" effect="dark" round>
          {{ connOk ? '● 实时连接中' : '○ 连接断开' }}
        </el-tag>
      </div>
    </header>

    <div class="layout">
      <aside class="sidebar">
        <div
          v-for="mod in modules"
          :key="mod.key"
          class="s-item"
          :class="{ active: view === mod.key }"
          @click="view = mod.key"
        >
          <span class="s-dot" :style="{ background: mod.color }"></span>
          {{ mod.name }}
        </div>
        <div class="s-item" :class="{ active: view === 'stats' }" @click="view = 'stats'">
          <span class="s-dot" style="background:#0ea5e9"></span>
          统计
        </div>
        <div class="s-item" :class="{ active: view === 'alerts' }" @click="view = 'alerts'">
          <span class="s-dot" style="background:#dc2626"></span>
          告警中心
          <span v-if="openAlertCount" class="alert-badge">{{ openAlertCount }}</span>
        </div>
      </aside>

      <main class="content">
        <template v-if="view === 'overview'">
          <el-card shadow="never" class="card">
            <template #header><span class="card-title">系统状态</span></template>
            <div class="status-row">
              <el-tag :type="status.mqtt ? 'success' : 'danger'" effect="light" round>MQTT 巴法云: {{ status.mqtt ? '已连接' : '断开' }}</el-tag>
              <el-tag :type="status.online ? 'success' : 'warning'" effect="light" round>设备: {{ status.online ? '在线' : '离线' }}</el-tag>
              <el-tag :type="errDisplay.type" effect="light" round>设备错误: {{ errDisplay.text }}</el-tag>
              <span class="ctrl-label">直连通道</span>
              <el-switch v-model="directEnabled" active-text="开" inactive-text="关" :disabled="!isAdmin" @change="onDirectSwitch" />
              <span class="status-hint">关 = 设备只走巴法云, 不直连本后端(约 1 分钟内生效)</span>
            </div>
          </el-card>

          <el-card shadow="never" class="card">
            <template #header><span class="card-title">实时数据(点击行进入模块详情)</span></template>
            <div class="list">
              <div v-for="m in groupModules" :key="m.key" class="row" @click="view = m.key">
                <span class="label"><span class="s-dot" :style="{ background: m.color }"></span>{{ m.name }}</span>
                <span class="val" :class="{ warn: moduleStatus(m).type === 'danger' }">
                  {{ latestFrame[m.key] ?? '--' }}<span class="unit">{{ m.unit }}</span>
                </span>
                <span class="row-tag">
                  <el-tag :type="moduleStatus(m).type" size="small" effect="plain">{{ moduleStatus(m).text }}</el-tag>
                </span>
              </div>
            </div>
          </el-card>

          <el-card shadow="never" class="card">
            <template #header><span class="card-title">远程控制</span></template>
            <div class="ctrl-row">
              <span class="ctrl-label">LED 状态</span>
              <el-switch v-model="ledOn" active-text="开" inactive-text="关" :disabled="!isAdmin" @change="onLedChange" />
              <el-tag v-if="ledState" :type="ledState === 'on' ? 'success' : 'info'" size="small">设备回执: {{ ledState === 'on' ? '开' : '关' }}</el-tag>
              <span class="ctrl-hint">指令: 看板 → 巴法云 → 联网板 → UART → 数据板</span>
            </div>
          </el-card>

          <el-card shadow="never" class="card">
            <template #header>
              <div class="chart-head">
                <span class="card-title">历史趋势({{ srcName(srcFilter) }})</span>
                <el-radio-group v-model="minutes" size="small" @change="loadOverviewHistory">
                  <el-radio-button v-for="o in rangeOptions" :key="o.v" :value="o.v">{{ o.label }}</el-radio-button>
                </el-radio-group>
              </div>
            </template>
            <div ref="overviewChartRef" class="chart"></div>
            <div class="zoom-wrap">
              <div class="zoom-track" @pointerdown.prevent="onZoomDown($event, 'overview')">
                <div class="zoom-fill" :style="zoomFill('overview')"></div>
                <div class="zoom-handle" :style="zoomHandle('overview', 's')"></div>
                <div class="zoom-handle" :style="zoomHandle('overview', 'e')"></div>
              </div>
              <div class="zoom-label">
                <span>{{ zoomTime('overview', 's') }}</span>
                <span class="zoom-hint">拖动两端蓝色手柄缩放 · 拖动蓝色区域平移</span>
                <span>{{ zoomTime('overview', 'e') }}</span>
              </div>
            </div>
            <div class="chart-empty" v-if="overviewEmpty">该时段暂无数据(设备未运行)</div>
          </el-card>

          <el-card shadow="never" class="card">
            <template #header>
              <div class="recent-head">
                <span class="card-title">最近记录(最新在上, 10 秒刷新)</span>
                <el-select v-model="recentSrc" size="small" style="width: 120px" @change="loadRecent">
                  <el-option v-for="o in recentSrcOptions" :key="o.v" :label="o.label" :value="o.v" />
                </el-select>
              </div>
            </template>
            <el-table :data="rows" size="small" stripe height="340">
              <el-table-column prop="timeStr" label="时间" width="180" />
              <el-table-column label="来源" width="80">
                <template #default="{ row }">{{ srcName(row.source) }}</template>
              </el-table-column>
              <el-table-column prop="temp" label="温度" />
              <el-table-column prop="hum" label="湿度" />
              <el-table-column prop="weight" label="重量" />
              <el-table-column prop="flow" label="水流" />
              <el-table-column prop="irtemp" label="红外" />
              <el-table-column prop="gas" label="烟雾" />
              <el-table-column prop="lux" label="光照" />
              <el-table-column prop="err" label="错误码" width="70" />
            </el-table>
          </el-card>
        </template>

        <template v-else-if="view === 'system'">
          <el-card shadow="never" class="card">
            <template #header><span class="card-title">系统状态详情</span></template>
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item label="后端服务">运行中 (端口 3000)</el-descriptions-item>
              <el-descriptions-item label="MQTT 巴法云">{{ status.mqtt ? '已连接' : '断开' }}</el-descriptions-item>
              <el-descriptions-item label="设备状态">{{ status.online ? '在线' : '离线' }}</el-descriptions-item>
              <el-descriptions-item label="最近数据">{{ lastTime || '--' }}</el-descriptions-item>
              <el-descriptions-item label="最近来源">{{ srcName(status.lastSource) }}</el-descriptions-item>
              <el-descriptions-item label="设备错误码">{{ errDisplay.text }}</el-descriptions-item>
              <el-descriptions-item label="WebSocket 连接数">{{ status.wsClients }}</el-descriptions-item>
              <el-descriptions-item label="直连通道">{{ status.directEnabled ? '开启' : '关闭' }}</el-descriptions-item>
              <el-descriptions-item label="在线判定">15 秒内收到数据</el-descriptions-item>
            </el-descriptions>
          </el-card>
          <el-card shadow="never" class="card">
            <template #header><span class="card-title">错误码说明</span></template>
            <el-table :data="errDocs" size="small" stripe>
              <el-table-column prop="code" label="错误码" width="80" />
              <el-table-column prop="text" label="含义" />
              <el-table-column prop="module" label="对应模块" />
            </el-table>
          </el-card>
          <el-card v-if="isAdmin" shadow="never" class="card">
            <template #header><span class="card-title">用户管理(管理员)</span></template>
            <div class="user-add">
              <el-input v-model="newUser.username" placeholder="用户名" size="small" style="width:140px" />
              <el-input v-model="newUser.password" type="password" placeholder="密码(至少6位)" size="small" style="width:160px" show-password />
              <el-select v-model="newUser.role" size="small" style="width:100px">
                <el-option label="只读" value="viewer" />
                <el-option label="管理员" value="admin" />
              </el-select>
              <el-button type="primary" size="small" @click="addUser">新增</el-button>
            </div>
            <el-table :data="users" size="small" stripe style="margin-top:8px">
              <el-table-column prop="id" label="ID" width="60" />
              <el-table-column prop="username" label="用户名" />
              <el-table-column label="角色" width="120">
                <template #default="{ row }">{{ row.role === 'admin' ? '管理员' : '只读' }}</template>
              </el-table-column>
              <el-table-column label="创建时间" width="180">
                <template #default="{ row }">{{ fmtDateTime(row.created_at) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="90">
                <template #default="{ row }">
                  <el-button v-if="row.username !== user.username" size="small" text type="danger" @click="removeUser(row.id)">删除</el-button>
                  <span v-else style="font-size:12px;color:#9ca3af">当前账号</span>
                </template>
              </el-table-column>
            </el-table>
            <div class="pwd-row">
              <el-input v-model="pwdForm.old" type="password" placeholder="原密码" size="small" style="width:130px" show-password />
              <el-input v-model="pwdForm.new" type="password" placeholder="新密码(至少6位)" size="small" style="width:160px" show-password />
              <el-button size="small" @click="changePwd">修改我的密码</el-button>
            </div>
          </el-card>
        </template>

        <template v-else-if="view === 'alerts'">
          <el-card shadow="never" class="card">
            <template #header>
              <div class="recent-head">
                <span class="card-title">告警中心</span>
                <div>
                  <el-radio-group v-model="alertStatus" size="small" @change="loadAlerts" style="margin-right:10px;">
                    <el-radio-button value="open">未解决</el-radio-button>
                    <el-radio-button value="all">全部</el-radio-button>
                  </el-radio-group>
                  <el-button size="small" @click="loadAlerts">刷新</el-button>
                </div>
              </div>
            </template>
            <el-table :data="alerts" size="small" stripe height="520">
              <el-table-column label="开始时间" width="170">
                <template #default="{ row }">{{ fmtDateTime(row.start_time) }}</template>
              </el-table-column>
              <el-table-column prop="module" label="模块" width="110" />
              <el-table-column label="级别" width="90">
                <template #default="{ row }"><el-tag :type="row.level === 'danger' ? 'danger' : 'warning'" size="small" effect="plain">{{ row.level === 'danger' ? '告警' : '提醒' }}</el-tag></template>
              </el-table-column>
              <el-table-column label="类型" width="90">
                <template #default="{ row }">{{ alertTypeName(row.type) }}</template>
              </el-table-column>
              <el-table-column prop="text" label="内容" />
              <el-table-column label="状态" width="100">
                <template #default="{ row }">
                  <el-tag :type="row.resolved ? 'info' : 'danger'" size="small">{{ row.resolved ? '已解决' : '进行中' }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="结束时间" width="170">
                <template #default="{ row }">{{ row.end_time ? fmtDateTime(row.end_time) : '—' }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </template>

        <template v-else-if="view === 'stats'">
          <el-card shadow="never" class="card">
            <template #header>
              <div class="recent-head">
                <span class="card-title">数据统计({{ srcName(statsSource) }})</span>
                <div class="stats-tools">
                  <el-radio-group v-model="statsType" size="small" @change="onStatsTypeChange">
                    <el-radio-button value="daily">日统计</el-radio-button>
                    <el-radio-button value="weekly">周统计</el-radio-button>
                  </el-radio-group>
                  <el-select v-model="statsRange" size="small" style="width:90px;margin-left:8px;" @change="loadStats">
                    <el-option v-for="o in statsRangeOptions" :key="o.v" :label="o.label" :value="o.v" />
                  </el-select>
                  <el-select v-model="statsSource" size="small" style="width:110px;margin-left:8px;" @change="loadStats">
                    <el-option v-for="o in recentSrcOptions" :key="o.v" :label="o.label" :value="o.v" />
                  </el-select>
                </div>
              </div>
            </template>
            <div class="stats-metric">
              <span class="m-label">指标:</span>
              <el-radio-group v-model="statsMetric" size="small" @change="renderStats">
                <el-radio-button v-for="m in statsMetrics" :key="m.key" :value="m.key">{{ m.name }}</el-radio-button>
              </el-radio-group>
            </div>
            <div ref="statsChartRef" class="chart" style="height:300px"></div>
            <div class="chart-empty" v-if="statsEmpty">该时间段暂无统计数据(设备未运行或数据源无数据)</div>
            <el-table :data="statsData" size="small" stripe style="margin-top:8px">
              <el-table-column :label="statsType === 'daily' ? '日期' : '周'" width="130">
                <template #default="{ row }">{{ row.day || row.week }}</template>
              </el-table-column>
              <el-table-column prop="cnt" label="记录数" width="80" />
              <el-table-column :label="metricName + ' 平均'" width="110">
                <template #default="{ row }">{{ row[statsMetric + '_avg'] ?? '—' }}</template>
              </el-table-column>
              <el-table-column :label="metricName + ' 最高'" width="110">
                <template #default="{ row }">{{ row[statsMetric + '_max'] ?? '—' }}</template>
              </el-table-column>
              <el-table-column :label="metricName + ' 最低'" width="110">
                <template #default="{ row }">{{ row[statsMetric + '_min'] ?? '—' }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </template>

        <template v-else-if="curModule">
          <el-card shadow="never" class="card">
            <template #header><span class="card-title">{{ curModule.name }} · 模块详情</span></template>
            <div class="mod-top">
              <div class="mod-big">
                <div class="m-label">{{ curModule.name }}</div>
                <div class="m-val" :class="{ warn: moduleStatus(curModule, srcFilter).type === 'danger' }">
                  {{ liveVal ?? '--' }}<span class="m-unit">{{ curModule.unit }}</span>
                </div>
              </div>
              <div class="mod-state">
                <el-tag :type="moduleStatus(curModule, srcFilter).type" effect="dark" round size="large">{{ moduleStatus(curModule, srcFilter).text }}</el-tag>
                <div class="mod-desc">{{ modStateDesc }}</div>
              </div>
            </div>
          </el-card>

          <el-card shadow="never" class="card">
            <template #header>
              <div class="chart-head">
                <span class="card-title">{{ curModule.name }}历史曲线({{ srcName(srcFilter) }})</span>
                <el-radio-group v-model="minutes" size="small" @change="loadModuleHistory">
                  <el-radio-button v-for="o in rangeOptions" :key="o.v" :value="o.v">{{ o.label }}</el-radio-button>
                </el-radio-group>
              </div>
            </template>
            <div ref="moduleChartRef" class="chart"></div>
            <div class="zoom-wrap">
              <div class="zoom-track" @pointerdown.prevent="onZoomDown($event, 'module')">
                <div class="zoom-fill" :style="zoomFill('module')"></div>
                <div class="zoom-handle" :style="zoomHandle('module', 's')"></div>
                <div class="zoom-handle" :style="zoomHandle('module', 'e')"></div>
              </div>
              <div class="zoom-label">
                <span>{{ zoomTime('module', 's') }}</span>
                <span class="zoom-hint">拖动两端手柄缩放 · 点空白处平移</span>
                <span>{{ zoomTime('module', 'e') }}</span>
              </div>
            </div>
            <div class="chart-empty" v-if="moduleEmpty">该时段暂无数据(设备未运行)</div>
          </el-card>
        </template>
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import * as echarts from 'echarts';

const modules = [
  { key: 'overview', name: '总览', color: '#64748b' },
  { key: 'temp',    name: '温度',     unit: '°C',    color: '#f97316', min: 10,  max: 40 },
  { key: 'hum',     name: '湿度',     unit: '%',     color: '#3b82f6', min: 20,  max: 90 },
  { key: 'weight',  name: '重量',     unit: 'g',     color: '#10b981' },
  { key: 'flow',    name: '水流',     unit: 'L/min', color: '#06b6d4' },
  { key: 'irtemp',  name: '红外体温', unit: '°C',    color: '#ef4444', min: 30,  max: 40 },
  { key: 'gas',     name: '烟雾浓度', unit: '',      color: '#8b5cf6' },
  { key: 'lux',     name: '光照',     unit: '',      color: '#eab308' },
  { key: 'system',  name: '系统状态', color: '#475569' },
];

const ERR_TEXT = { 0: '正常', 1: '称重故障', 2: '红外未找到', 3: '温湿度读取失败', 4: '气体异常' };
const ERR_MODULES = { 1: ['weight'], 2: ['irtemp'], 3: ['temp', 'hum'], 4: ['gas'] };
const errDocs = [
  { code: 0, text: '正常', module: '—' },
  { code: 1, text: '称重故障(HX711 超时)', module: '重量' },
  { code: 2, text: '红外未找到(MLX90614)', module: '红外体温' },
  { code: 3, text: '温湿度读取失败(DHT22)', module: '温度 / 湿度' },
  { code: 4, text: '气体异常(MQ-2 连续读 0)', module: '烟雾浓度' },
];

const view = ref('overview');
const srcFilter = ref('all');
const rows = ref([]);
const recentSrcOptions = [
  { label: '全部来源', v: 'all' },
  { label: '直连', v: 'direct' },
  { label: '巴法云', v: 'mqtt' },
];
const recentSrc = ref('all');      // 最近记录表格的独立来源筛选

// ---- 登录 / 用户 / 告警 ----
const token = ref(localStorage.getItem('bj_token') || '');
let savedUser = null;
try { savedUser = JSON.parse(localStorage.getItem('bj_user') || 'null'); } catch (e) { savedUser = null; }
const user = ref(savedUser);
const isAdmin = computed(() => !!(user.value && user.value.role === 'admin'));
const loginForm = reactive({ username: '', password: '' });
const loginLoading = ref(false);
const loginErr = ref('');
const alerts = ref([]);
const openAlerts = ref([]);
const openAlertCount = computed(() => openAlerts.value.length);
const alertStatus = ref('open');
const users = ref([]);
const newUser = reactive({ username: '', password: '', role: 'viewer' });
const pwdForm = reactive({ old: '', new: '' });

// 模块列表(不含总览/系统状态)
const groupModules = modules.filter((x) => x.key !== 'overview' && x.key !== 'system');
// 分来源的实时数据 / 在线状态 / 最近一帧(总览用)
const liveBySource = reactive({ direct: {}, mqtt: {} });
const srcState = reactive({
  direct: { online: false, err: 0, lastTime: 0 },
  mqtt: { online: false, err: 0, lastTime: 0 },
});
const latestFrame = reactive({});

// 模块详情: 来源跟随顶部"数据源"下拉(全部时查全部来源, 取最近一帧)
const curModule = computed(() =>
  view.value !== 'overview' && view.value !== 'system'
    ? modules.find((x) => x.key === view.value) || null
    : null
);
const liveVal = computed(() => {
  const m = curModule.value;
  if (!m) return null;
  if (srcFilter.value === 'direct' || srcFilter.value === 'mqtt') {
    const box = liveBySource[srcFilter.value];
    return box ? (box[m.key] ?? null) : null;
  }
  return latestFrame[m.key] ?? null;
});
const connOk = ref(false);
const lastTime = ref('');
const ledOn = ref(false);
const ledState = ref('');
const minutes = ref(1440);   // 默认 1 天(设备数据稀疏, 短窗口常空白)
const rangeOptions = [
  { label: '10分钟', v: 10 },
  { label: '1小时', v: 60 },
  { label: '1天', v: 1440 },
  { label: '1周', v: 10080 },
];
const status = reactive({ mqtt: false, online: false, err: 0, wsClients: 0, lastSource: null, directEnabled: true });
const directEnabled = ref(true);

// ---- 统计页(日/周聚合) ----
const statsType = ref('daily');
const statsRange = ref('7');
const statsSource = ref('all');
const statsMetric = ref('temp');
const statsData = ref([]);
const statsEmpty = ref(false);
const statsChartRef = ref(null);
let statsChart = null;
const statsMetrics = modules.filter((x) => x.key !== 'overview' && x.key !== 'system');
const metricName = computed(() => {
  const m = statsMetrics.find((x) => x.key === statsMetric.value);
  return m ? m.name : statsMetric.value;
});
const statsRangeOptions = computed(() =>
  statsType.value === 'weekly'
    ? [{ label: '4周', v: '4' }, { label: '8周', v: '8' }, { label: '12周', v: '12' }]
    : [{ label: '7天', v: '7' }, { label: '14天', v: '14' }, { label: '30天', v: '30' }]
);
function initStatsChart() {
  if (!statsChartRef.value) return;
  if (statsChart) statsChart.dispose();
  statsChart = echarts.init(statsChartRef.value);
}
function renderStats() {
  if (!statsChart) initStatsChart();
  const rows = statsData.value;
  if (!rows || !rows.length) { statsEmpty.value = true; if (statsChart) statsChart.clear(); return; }
  statsEmpty.value = false;
  const key = statsMetric.value;
  const label = metricName.value;
  const cats = rows.map((r) => r.day || r.week);
  statsChart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 55, right: 20, top: 45, bottom: 30 },
    xAxis: { type: 'category', data: cats },
    yAxis: { type: 'value', scale: true },
    series: [
      { name: label + ' 平均', type: 'line', showSymbol: true, data: rows.map((r) => r[key + '_avg']), color: '#3b82f6' },
      { name: label + ' 最高', type: 'line', showSymbol: true, data: rows.map((r) => r[key + '_max']), color: '#ef4444' },
      { name: label + ' 最低', type: 'line', showSymbol: true, data: rows.map((r) => r[key + '_min']), color: '#10b981' },
    ],
  });
}
function loadStats() {
  const q = statsType.value === 'weekly' ? 'weeks' : 'days';
  api(`/api/stats/${statsType.value}?${q}=${statsRange.value}&source=${statsSource.value}`)
    .then((data) => { if (Array.isArray(data)) { statsData.value = data; renderStats(); } })
    .catch(() => {});
}
function onStatsTypeChange() {
  statsRange.value = statsType.value === 'weekly' ? '4' : '7';
  loadStats();
}

/** 统一请求: 自动带登录 token; 401 时清除登录态(回到登录页) */
function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token.value) headers.Authorization = 'Bearer ' + token.value;
  let body = opts.body;
  if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  return fetch(path, { ...opts, headers, body }).then(async (r) => {
    if (r.status === 401) {
      token.value = '';
      user.value = null;
      localStorage.removeItem('bj_token');
      localStorage.removeItem('bj_user');
      throw new Error('unauthorized');
    }
    return r.json();
  });
}

function doLogin() {
  if (!loginForm.username || !loginForm.password) { loginErr.value = '请输入用户名和密码'; return; }
  loginLoading.value = true;
  loginErr.value = '';
  fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(loginForm),
  })
    .then((r) => r.json())
    .then((d) => {
      if (d && d.ok) {
        token.value = d.token;
        user.value = d.user;
        localStorage.setItem('bj_token', d.token);
        localStorage.setItem('bj_user', JSON.stringify(d.user));
        view.value = 'overview';
        loadAll();
      } else {
        loginErr.value = (d && d.error) || '登录失败';
      }
    })
    .catch(() => { loginErr.value = '无法连接后端服务'; })
    .finally(() => { loginLoading.value = false; });
}

function logout() {
  token.value = '';
  user.value = null;
  localStorage.removeItem('bj_token');
  localStorage.removeItem('bj_user');
  view.value = 'overview';
}

function loadAll() {
  loadRecent();
  loadStatus();
  loadAlerts();
  loadUsers();
  if (view.value === 'overview') loadOverviewHistory();
  else if (view.value === 'stats') loadStats();
  else if (view.value !== 'system' && view.value !== 'alerts' && curModule.value) loadModuleHistory();
}

function onDirectSwitch(val) {
  api('/api/config/direct', { method: 'POST', body: { enabled: !!val } })
    .then((d) => { if (d && d.ok) directEnabled.value = !!d.enabled; })
    .catch(() => {});
}

const overviewChartRef = ref(null);
const moduleChartRef = ref(null);
const overviewEmpty = ref(false);
const moduleEmpty = ref(false);

let ws = null;
let timer = null;
let statusTimer = null;
let chartTimer = null;
let overviewChart = null;
let moduleChart = null;

// ---- 自定义时间轴(图表下方独立区, 图例之下) ----
const zoom = reactive({ overview: { s: 0, e: 100 }, module: { s: 0, e: 100 } });
const chartTimes = reactive({ overview: [], module: [] });   // 时间戳(ms), 升序(响应式, 时间轴条随数据刷新)
const syncLock = { overview: false, module: false };

// 1 分钟对应的窗口百分比(数据总跨度不足1分钟时返回100=不可再缩小)
function minSpanPct(key) {
  const arr = chartTimes[key];
  if (!arr || arr.length < 2) return 0;
  const total = arr[arr.length - 1] - arr[0];
  if (total <= 0) return 0;
  return Math.min(100, (60000 / total) * 100);
}

function zoomFill(key) {
  const z = zoom[key];
  return { left: z.s + '%', width: Math.max(0, z.e - z.s) + '%' };
}
function zoomHandle(key, side) {
  const z = zoom[key];
  return { left: (side === 's' ? z.s : z.e) + '%' };
}
function zoomTime(key, side) {
  const arr = chartTimes[key];
  if (!arr.length) return '--';
  const z = zoom[key];
  const pct = side === 's' ? z.s : z.e;
  const idx = Math.min(arr.length - 1, Math.max(0, Math.round((pct / 100) * (arr.length - 1))));
  return fmtTime(new Date(arr[idx]));
}
function pctToIdx(key, p) {
  const arr = chartTimes[key];
  if (!arr.length) return -1;
  return Math.min(arr.length - 1, Math.max(0, Math.round((p / 100) * (arr.length - 1))));
}
function idxToPct(key, idx) {
  const arr = chartTimes[key];
  if (!arr.length) return 0;
  return (idx / (arr.length - 1)) * 100;
}
// 拖动时对齐到 1 分钟(取该分钟内的第一个数据点)
function snapToMinute(key, p) {
  const arr = chartTimes[key];
  if (!arr.length) return p;
  let idx = pctToIdx(key, p);
  const d = new Date(arr[idx]);
  const minuteStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), 0, 0).getTime();
  while (idx > 0 && arr[idx - 1] >= minuteStart) idx--;
  return idxToPct(key, idx);
}
function onZoomDown(ev, key) {
  const el = ev.currentTarget;
  const rect = el.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * 100;
  const z = zoom[key];
  let mode = null;
  let offset = 0;
  if (Math.abs(x - z.s) <= 8) mode = 's';
  else if (Math.abs(x - z.e) <= 8) mode = 'e';
  else if (x > z.s && x < z.e) { mode = 'pan'; offset = x - z.s; }
  else return;   // 点击选中区外的空白: 不做动作
  const move = (e2) => {
    const r2 = el.getBoundingClientRect();
    let p = ((e2.clientX - r2.left) / r2.width) * 100;
    p = Math.min(100, Math.max(0, p));
    const zz = zoom[key];
    const span = zz.e - zz.s;
    const minSpan = minSpanPct(key);            // 动态下限: 窗口最小 1 分钟
    if (mode === 's') {
      const np = snapToMinute(key, p);
      if (np < zz.e - minSpan) zz.s = np;
    } else if (mode === 'e') {
      const np = snapToMinute(key, p);
      if (np > zz.s + minSpan) zz.e = np;
    } else if (mode === 'pan') {
      let ns = p - offset;
      if (ns < 0) ns = 0;
      if (ns + span > 100) ns = 100 - span;
      zz.s = ns;
      zz.e = ns + span;
    }
    applyZoomDispatch(key);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
function applyZoomDispatch(key) {
  const chart = key === 'overview' ? overviewChart : moduleChart;
  if (!chart) return;
  const z = zoom[key];
  syncLock[key] = true;
  chart.dispatchAction({ type: 'dataZoom', start: z.s, end: z.e });
  setTimeout(() => { syncLock[key] = false; }, 80);
}
// 滚轮/图表内缩放 → 同步移动轴手柄位置
function bindZoomSync(key) {
  const chart = key === 'overview' ? overviewChart : moduleChart;
  if (!chart) return;
  chart.off('datazoom');
  chart.on('datazoom', () => {
    if (syncLock[key]) return;
    const dz = chart.getOption().dataZoom;
    if (Array.isArray(dz) && dz.length && dz[0].start !== undefined) {
      zoom[key].s = dz[0].start;
      zoom[key].e = dz[0].end;
    }
  });
}
function resetZoom(key) {
  zoom[key].s = 0;
  zoom[key].e = 100;
  applyZoomDispatch(key);
}

function srcName(s) {
  if (s === 'direct') return '直连';
  if (s === 'mqtt') return '巴法云';
  if (s === 'all') return '全部';
  return '—';
}

const errDisplay = computed(() => {
  if (!status.online) return { type: 'warning', text: '设备离线' };
  if (status.err === 0) return { type: 'success', text: '正常' };
  return { type: 'danger', text: ERR_TEXT[status.err] || ('错误码 ' + status.err) };
});

function moduleStatus(m, source) {
  if (!m || m.key === 'overview' || m.key === 'system') return { type: 'info', text: '—' };
  let st = null;
  let v = null;
  if (source === 'direct' || source === 'mqtt') {
    st = srcState[source];
    v = liveBySource[source] ? liveBySource[source][m.key] : null;
  } else {
    st = { online: status.online, err: status.err };
    v = latestFrame[m.key];
  }
  if (st && !st.online) return { type: 'warning', text: '设备离线' };
  if (st && ERR_MODULES[st.err]?.includes(m.key)) return { type: 'danger', text: '传感器故障' };
  if (v === undefined || v === null) return { type: 'info', text: '等待数据' };
  if (m.min !== undefined && v < m.min) return { type: 'danger', text: `低于下限 ${m.min}` };
  if (m.max !== undefined && v > m.max) return { type: 'danger', text: `超过上限 ${m.max}` };
  return { type: 'success', text: '正常' };
}

const modStateDesc = computed(() => {
  if (!curModule.value) return '';
  const s = moduleStatus(curModule.value, srcFilter.value);
  if (s.type === 'success') return '该模块运行正常, 数据在正常范围内';
  if (s.type === 'warning') return '设备离线中, 无法获取该模块数据';
  if (s.type === 'danger') {
    if (s.text === '传感器故障') return '该模块传感器上报故障, 请检查接线/供电';
    return `数据超出告警范围: ${s.text}`;
  }
  return '等待设备上报数据…';
});

function applyRow(r) {
  if (!r || !r.source) return;
  const box = liveBySource[r.source];
  if (!box) return;
  for (const m of groupModules) {
    if (r[m.key] !== undefined) box[m.key] = r[m.key];
  }
  const st = srcState[r.source];
  if (st) {
    st.lastTime = Date.now();
    st.online = true;                       // 收到数据立即在线
    if (r.err !== undefined && r.err !== null) st.err = r.err;
  }
  Object.assign(latestFrame, r);
  lastTime.value = r.timeStr || '';
  if (r.err !== undefined && r.err !== null) status.err = r.err;
}

function loadAlerts() {
  api(`/api/alerts?limit=50&status=${alertStatus.value}`)
    .then((d) => { if (Array.isArray(d)) alerts.value = d; })
    .catch(() => {});
  api('/api/alerts?limit=100&status=open')
    .then((d) => { if (Array.isArray(d)) openAlerts.value = d; })
    .catch(() => {});
}

function loadUsers() {
  if (!isAdmin.value) return;
  api('/api/users')
    .then((d) => { if (d && d.ok) users.value = d.users; })
    .catch(() => {});
}

function addUser() {
  if (!newUser.username || !newUser.password) { window.alert('请输入用户名和密码'); return; }
  if (newUser.password.length < 6) { window.alert('密码至少 6 位'); return; }
  api('/api/users', { method: 'POST', body: { username: newUser.username, password: newUser.password, role: newUser.role } })
    .then((d) => {
      if (d && d.ok) { users.value = d.users; newUser.username = ''; newUser.password = ''; }
      else window.alert((d && d.error) || '创建失败');
    })
    .catch(() => {});
}

function removeUser(id) {
  api('/api/users/' + id, { method: 'DELETE' })
    .then((d) => { if (d && d.ok) users.value = d.users; })
    .catch(() => {});
}

function changePwd() {
  if (!pwdForm.old || !pwdForm.new) { window.alert('请填写原密码和新密码'); return; }
  if (pwdForm.new.length < 6) { window.alert('新密码至少 6 位'); return; }
  api('/api/auth/password', { method: 'POST', body: { old: pwdForm.old, new: pwdForm.new } })
    .then((d) => {
      if (d && d.ok) { pwdForm.old = ''; pwdForm.new = ''; window.alert('密码已修改'); }
      else window.alert((d && d.error) || '修改失败');
    })
    .catch(() => {});
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function alertTypeName(t) {
  return ({ threshold: '阈值', err: '故障', offline: '离线' })[t] || t;
}

function loadRecent() {
  api(`/api/recent?limit=20&source=${recentSrc.value}`)
    .then((data) => { if (Array.isArray(data)) rows.value = data; })
    .catch(() => {});
}

function loadStatus() {
  api('/api/status')
    .then((s) => {
      if (!s || !s.ok) return;
      status.mqtt = !!s.mqttConnected;
      status.online = !!s.deviceOnline;
      status.wsClients = s.wsClients || 0;
      if (s.lastErr !== null && s.lastErr !== undefined) status.err = s.lastErr;
      status.lastSource = s.lastSource;
      if (s.directEnabled !== undefined) {
        status.directEnabled = !!s.directEnabled;
        directEnabled.value = !!s.directEnabled;
      }
      if (s.lastDataTime) {
        const t = new Date(s.lastDataTime);
        const p = (n) => (n < 10 ? '0' + n : '' + n);
        lastTime.value = `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
      }
    })
    .catch(() => {});
}

function baseOption(key, axes = 1) {
  const ms = minSpanPct(key);                               // 滚轮缩放最小 1 分钟
  const yAxis =
    axes === 2
      ? [
          { type: 'value', scale: true, name: '温度/红外 °C' },
          { type: 'value', scale: true, name: '湿度% · 重量g', position: 'right', splitLine: { show: false } },
        ]
      : [{ type: 'value', scale: true }];
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },                                    // 图例在最上方, 不占底部空间
    grid: { left: 55, right: axes === 2 ? 55 : 20, top: 45, bottom: 45 },    // 右轴留白
    xAxis: { type: 'category', boundaryGap: false, axisLabel: { margin: 10 } },
    yAxis,
    dataZoom: [{ type: 'inside', minSpan: ms > 0 ? ms : undefined }],
  };
}

function initOverviewChart() {
  if (!overviewChartRef.value) return;
  if (overviewChart) overviewChart.dispose();
  overviewChart = echarts.init(overviewChartRef.value);
  bindZoomSync('overview');
}

function loadOverviewHistory(reset = true) {
  api(`/api/history?minutes=${minutes.value}&limit=2000&source=${srcFilter.value}`)
    .then((data) => {
      if (!Array.isArray(data) || data.length === 0) {
        overviewEmpty.value = true;
        chartTimes.overview = [];
        if (overviewChart) overviewChart.clear();
        return;
      }
      overviewEmpty.value = false;
      if (!overviewChart) initOverviewChart();
      chartTimes.overview = data.map((d) => new Date(d.time).getTime());
      const times = chartTimes.overview.map((t) => fmtTime(new Date(t)));
      overviewChart.setOption({
        ...baseOption('overview', 2),
        legend: { data: ['温度', '湿度', '重量', '红外'], top: 0 },
        xAxis: { data: times },
        series: [
          { name: '温度', type: 'line', showSymbol: false, data: data.map((d) => d.temp), color: '#f97316', yAxisIndex: 0 },
          { name: '湿度', type: 'line', showSymbol: false, data: data.map((d) => d.hum), color: '#3b82f6', yAxisIndex: 1 },
          { name: '重量', type: 'line', showSymbol: false, data: data.map((d) => d.weight), color: '#10b981', yAxisIndex: 1 },
          { name: '红外', type: 'line', showSymbol: false, data: data.map((d) => d.irtemp), color: '#ef4444', yAxisIndex: 0 },
        ],
      });
      if (reset) resetZoom('overview');   // 定时刷新不重置用户缩放窗口
    })
    .catch(() => {});
}

function initModuleChart() {
  if (!moduleChartRef.value) return;
  if (moduleChart) moduleChart.dispose();
  moduleChart = echarts.init(moduleChartRef.value);
  bindZoomSync('module');
}

function loadModuleHistory(reset = true) {
  const m = curModule.value;
  if (!m || !moduleChartRef.value) return;
  api(`/api/history?minutes=${minutes.value}&limit=2000&source=${srcFilter.value}`)
    .then((data) => {
      if (!Array.isArray(data) || data.length === 0) {
        moduleEmpty.value = true;
        chartTimes.module = [];
        if (moduleChart) moduleChart.clear();
        return;
      }
      moduleEmpty.value = false;
      if (!moduleChart) initModuleChart();
      chartTimes.module = data.map((d) => new Date(d.time).getTime());
      const times = chartTimes.module.map((t) => fmtTime(new Date(t)));
      moduleChart.setOption({
        ...baseOption('module'),
        xAxis: { data: times },
        series: [{
          name: m.name, type: 'line', showSymbol: false,
          data: data.map((d) => d[m.key]), color: m.color,
          areaStyle: { opacity: 0.08 },
        }],
      });
      if (reset) resetZoom('module');     // 定时刷新不重置用户缩放窗口
    })
    .catch(() => {});
}

function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

watch(view, async () => {
  await nextTick();
  if (view.value === 'overview') {
    if (moduleChart) { moduleChart.dispose(); moduleChart = null; }
    initOverviewChart();
    loadOverviewHistory();
  } else if (view.value === 'system') {
    if (overviewChart) { overviewChart.dispose(); overviewChart = null; }
    if (moduleChart) { moduleChart.dispose(); moduleChart = null; }
    loadStatus();
    loadUsers();
  } else if (view.value === 'alerts') {
    if (overviewChart) { overviewChart.dispose(); overviewChart = null; }
    if (moduleChart) { moduleChart.dispose(); moduleChart = null; }
    loadAlerts();
  } else if (view.value === 'stats') {
    if (overviewChart) { overviewChart.dispose(); overviewChart = null; }
    if (moduleChart) { moduleChart.dispose(); moduleChart = null; }
    initStatsChart();
    loadStats();
  } else if (curModule.value) {
    if (overviewChart) { overviewChart.dispose(); overviewChart = null; }
    initModuleChart();
    loadModuleHistory();
  }
});

function onSrcChange() {
  loadRecent();
  if (view.value === 'overview') loadOverviewHistory();
  else if (view.value === 'stats') loadStats();
  else if (view.value !== 'system') loadModuleHistory();
  loadStatus();
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host + '/ws');
  ws.onopen = () => { connOk.value = true; };
  ws.onclose = () => { connOk.value = false; setTimeout(connectWs, 3000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if ((m.type === 'data' || m.type === 'latest') && m.data) {
      applyRow(m.data);   // 各来源都入库, 左侧分组按来源查看
    }
    if (m.type === 'state') {
      ledState.value = m.state;
      ledOn.value = m.state === 'on';
    }
    if (m.type === 'alert') {
      loadAlerts();
    }
  };
}

function onLedChange(val) {
  api('/api/control', { method: 'POST', body: { action: val ? 'on' : 'off' } }).catch(() => {});
}

onMounted(async () => {
  connectWs();
  if (token.value) loadAll();
  timer = setInterval(loadRecent, 10000);
  statusTimer = setInterval(() => {
    loadStatus();
    const now = Date.now();
    srcState.direct.online = now - srcState.direct.lastTime < 15000;
    srcState.mqtt.online = now - srcState.mqtt.lastTime < 15000;
  }, 5000);
  await nextTick();
  const now = Date.now();
  srcState.direct.online = now - srcState.direct.lastTime < 15000;
  srcState.mqtt.online = now - srcState.mqtt.lastTime < 15000;
  if (token.value) {
    initOverviewChart();
    loadOverviewHistory();
  }
  chartTimer = setInterval(() => {
    if (!token.value) return;
    if (view.value === 'overview') loadOverviewHistory(false);      // 定时刷新保持缩放窗口
    else if (view.value === 'stats') loadStats();
    else if (view.value !== 'system' && view.value !== 'alerts' && curModule.value) loadModuleHistory(false);
  }, 60000);
});

onUnmounted(() => {
  if (ws) ws.close();
  if (timer) clearInterval(timer);
  if (statusTimer) clearInterval(statusTimer);
  if (chartTimer) clearInterval(chartTimer);
  if (overviewChart) { overviewChart.dispose(); overviewChart = null; }
  if (moduleChart) { moduleChart.dispose(); moduleChart = null; }
  if (statsChart) { statsChart.dispose(); statsChart = null; }
});
</script>

<style>
* { box-sizing: border-box; margin: 0; }
body { background: #f0f2f5; }
.page { max-width: 1200px; margin: 0 auto; padding: 20px; font-family: "Microsoft YaHei", sans-serif; }
.top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 10px; }
.top h1 { font-size: 22px; color: #1f2937; }
.sub { font-size: 13px; color: #6b7280; margin-top: 2px; }
.status { display: flex; align-items: center; }

.layout { display: flex; gap: 14px; align-items: flex-start; }
.sidebar { width: 150px; flex-shrink: 0; background: #fff; border-radius: 10px; padding: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.06); position: sticky; top: 20px; }
.s-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; color: #374151; user-select: none; }
.s-item:hover { background: #f3f4f6; }
.s-item.active { background: #eef2ff; color: #4f46e5; font-weight: 600; }
.s-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.content { flex: 1; min-width: 0; }
.card { margin-bottom: 14px; border-radius: 10px; }
.card-title { font-size: 15px; font-weight: 600; }
.status-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.status-hint { font-size: 12px; color: #9ca3af; margin-left: 4px; }
.chart-head { display: flex; justify-content: space-between; align-items: center; width: 100%; }
.recent-head { display: flex; justify-content: space-between; align-items: center; width: 100%; }
.chart { width: 100%; height: 320px; }
.chart-empty { color: #9ca3af; font-size: 13px; text-align: center; padding: 20px 0; }

/* 自定义时间轴(图表下方独立区) */
.zoom-wrap { margin-top: 10px; }
.zoom-track { position: relative; height: 26px; background: #e2e8f0; border-radius: 8px; cursor: pointer; user-select: none; touch-action: none; }
.zoom-fill { position: absolute; top: 0; bottom: 0; background: rgba(59,130,246,.28); border-radius: 8px; }
.zoom-handle { position: absolute; top: -5px; width: 14px; height: 36px; margin-left: -7px; background: #3b82f6; border-radius: 4px; cursor: ew-resize; box-shadow: 0 1px 4px rgba(0,0,0,.35); }
.zoom-label { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #64748b; margin-top: 5px; }
.zoom-hint { color: #b0bec5; font-size: 11px; }

.list { display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; justify-content: space-between; align-items: center; background: #f9fafb; border-radius: 10px; padding: 10px 16px; cursor: pointer; }
.row:hover { background: #f3f4f6; }
.row .label { font-size: 14px; color: #374151; display: flex; align-items: center; gap: 8px; }
.row .val { font-size: 20px; font-weight: 700; color: #1f2937; }
.row .val.warn { color: #e53e3e; }
.row .unit { font-size: 12px; color: #9ca3af; font-weight: 400; margin-left: 4px; }
.row-tag { width: 90px; text-align: right; }

.ctrl-row { display: flex; align-items: center; gap: 8px; }
.ctrl-label { font-size: 14px; color: #374151; }
.ctrl-hint { font-size: 12px; color: #9ca3af; margin-left: 12px; }

.mod-top { display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
.mod-big { background: #f9fafb; border-radius: 12px; padding: 20px 40px; text-align: center; }
.mod-big .m-label { font-size: 14px; color: #9ca3af; }
.mod-big .m-val { font-size: 40px; font-weight: 700; color: #1f2937; margin-top: 6px; }
.mod-big .m-val.warn { color: #e53e3e; }
.mod-big .m-unit { font-size: 14px; color: #9ca3af; font-weight: 400; margin-left: 4px; }
.mod-state .mod-desc { font-size: 13px; color: #6b7280; margin-top: 8px; max-width: 320px; }

/* 登录页 */
.login-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f0f2f5; }
.login-box { width: 330px; background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 2px 12px rgba(0,0,0,.08); display: flex; flex-direction: column; gap: 12px; }
.login-box h2 { font-size: 18px; color: #1f2937; text-align: center; margin-bottom: 4px; }
.login-err { color: #dc2626; font-size: 13px; text-align: center; }
.user { font-size: 13px; color: #374151; margin-right: 8px; }
.u-role { color: #9ca3af; margin-left: 4px; }
.alert-badge { margin-left: auto; background: #dc2626; color: #fff; min-width: 18px; height: 18px; border-radius: 9px; text-align: center; line-height: 18px; font-size: 11px; padding: 0 4px; }
.user-add { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.pwd-row { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
.stats-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.stats-metric { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.stats-metric .m-label { font-size: 13px; color: #64748b; }

/* ===== 移动端适配 (手机/平板 <=768px) ===== */
@media (max-width: 768px) {
  .page { padding: 12px; }
  .top h1 { font-size: 17px; }
  .top .sub { font-size: 12px; }
  .status { flex-wrap: wrap; gap: 6px; }
  .status .el-select { width: 120px !important; margin-right: 6px !important; }
  .layout { flex-direction: column; gap: 10px; }
  .sidebar { width: 100%; position: static; display: flex; gap: 4px; overflow-x: auto; padding: 6px; -webkit-overflow-scrolling: touch; }
  .s-item { flex-shrink: 0; white-space: nowrap; padding: 7px 10px; }
  .content { width: 100%; }
  .card-title { font-size: 14px; }
  .chart-head, .recent-head { flex-direction: column; align-items: flex-start; gap: 8px; }
  .chart { height: 250px; }
  .zoom-track { height: 30px; }
  .zoom-handle { top: -8px; height: 44px; width: 18px; margin-left: -9px; }
  .zoom-hint { display: none; }
  .row { padding: 9px 12px; }
  .row .val { font-size: 17px; }
  .row-tag { width: 76px; }
  .mod-big { padding: 14px 20px; }
  .mod-big .m-val { font-size: 30px; }
  .mod-big .m-unit { font-size: 12px; }
  .ctrl-row { flex-wrap: wrap; }
  .status-hint { width: 100%; margin-left: 0; }
  .login-box { width: 88%; max-width: 330px; padding: 26px 22px; }
  .el-table { width: 100%; }
  .el-descriptions { width: 100%; }
}
</style>
