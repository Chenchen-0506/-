const { Buffer } = require('buffer');
globalThis.Buffer = Buffer;
globalThis.process = globalThis.process || {};
globalThis.process.nextTick = globalThis.process.nextTick || ((cb) => setTimeout(cb, 0));

App({
  onLaunch: function () {
    this.globalData = {
      env: "cloud1-d5gs39jihe019e38b",
    };
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true,
      });
    }
  },
});