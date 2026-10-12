// 最近数据页: 从云开发数据库读取 sensor_records 最近 20 条平均记录
Page({
  data: {
    list: [],
    loading: true,
  },

  onLoad() {
    this.loadData();
  },

  onPullDownRefresh() {
    this.loadData(() => wx.stopPullDownRefresh());
  },

  loadData(done) {
    const db = wx.cloud.database();
    db.collection('sensor_records')
      .orderBy('time', 'desc')
      .limit(20)
      .get()
      .then(res => {
        const list = res.data;   // 时间倒序: 最新一条在最上面
        this.setData({ list, loading: false });
        done && done();
      })
      .catch(err => {
        console.error('读取最近数据失败', err);
        this.setData({ loading: false });
        done && done();
      });
  },
});
