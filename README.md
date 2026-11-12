# BitIndex · Bitcoin 指数看板

当前包含两个互相跳转的页面：`index.html` 只展示 12 项指数；`prediction.html` 展示 agent 事件研判、7 天/30 天三种价格情景、历史事件影响等级和每日对照。原 14 份岭回归预测及金融模型参考移到预测页下方，保持原样。行情来自 Coin Metrics Community API，无需 API Key。

在线版：**https://maons666.github.io/BitIndex/**。GitHub Pages 使用已发布快照，刷新按钮读取最新发布数据；GitHub Actions 定时抓取真实日线并保存对照。部署方法及持久化结构见 [GitHub Pages 部署说明](docs/GitHub-Pages部署.md)。

## 启动

需要 Node.js 22 或更高版本，没有第三方依赖，不需要 `npm install`。

```powershell
npm start
```

打开 **http://127.0.0.1:8787**。也可双击根目录 `start-dashboard.cmd`。刷新按钮会重新请求数据；日线尚未更新时数值保持不变。请通过本地服务访问，不要直接双击 HTML。

## 使用

在指数选择器中勾选即可同图比较，支持搜索、分类、全选、清空和常用组合，选择会保留。默认显示截至当日的历史分位（0–100），也可切换原始单位；负数原值自动禁用对数刻度。支持 90 天 / 1 年 / 3 年 / 全部历史、价格叠加、鼠标及键盘查看、分页表格、已选指标 CSV 导出、明暗主题。成本参数及 AHR999 均值口径可调整并本地保存。页面顶部“指标说明”集中展示全部公式、数据来源及局限。

保留 AHR999、挖矿成本比率、Pi Cycle Top、MVRV、Puell；新增 Mayer Multiple、NUPL、RSI 14、30 日年化波动率、60 日累计涨幅、Hash Ribbon 比率、两年均线倍数。

挖矿成本目前采用真实算力和发行量的**固定参数电费模型**，不是已验证的“江卓尔官方指数”，也不是全成本生产价。MVRV 和 Puell 是 Glassnode 收录的指标，当前数据提供方是 Coin Metrics。

[API Key 选项清单](docs/API-Key-选项清单.md) 整理了可选官方数据源，待你决定后接入。

## 历史预测与实际对照

新的[预测页面](https://maons666.github.io/BitIndex/prediction.html)读取已签发的 agent 分析，不在浏览器生成新事件预测。免费更新方式：在对话中触发 agent 核查事件、更新案例库并发布；GitHub 每天只更新实际行情和对照。事件分析超过 7 天会提示复核，价格刷新不会更改原预测。历史案例按事前波动标准化后的价格偏离分为 L1—L4，新事件展示匹配样本数和差异；没有案例时标“待积累”。四个精选初始案例有选择偏差，不能冒充完整训练集或已验证的因果效应。

新分析、输入、来源与预测保存在独立的 [event-predictions/](event-predictions/README.md)；每日实际对照保存在 `tracking-data` 分支的 `predictions/events/comparisons/`。7 天和 30 天分别与“不加事件”“价格不变”基准比较，精确目标日到齐后才计算误差。

“我的模型”默认显示**历次预测曲线**：原版和外部因素版各有 7 期真实留档，目标日为 2026-11-17 至 2026-11-23；每个点按原目标日期绘制，提示框保留签发时间、原基准日与 30 日期限。实线为实际价格，虚线连接相邻目标日的预测，缺日不补造。各点来自不同签发日，并非同一次预测未来每天的路径。也可切换“最新一期目标”，查看原基准价到单个目标价的连线。CSV 按当前视图导出全部目标或单期目标，保持各自签发信息。预测到期后不会自动延伸目标日，原始预测不修改、不新增。

价格预期看板另提供 GBM（几何布朗运动）、对数趋势和价格不变基准，可选 7 / 30 / 90 天预测期、90 / 180 / 365 天估计窗口。这些金融模型从最新完整 UTC 日收盘起算，历史价格为实线、未来价格为虚线；GBM 提供固定参数假设下的 95% 条件价格区间，不是实测准确率。模型示意、公式和说明集中在页面中，CSV 保留实际值、各模型预期及来源时间。金融模型随发布数据和选择重新计算，不写入旧预测档案。

独立的 **[predictions/](predictions/README.md)** 保留原来的两版预测、模型参数和输入快照，现已停止训练和生成新预测。网页“更新实际数据”重新获取 Coin Metrics 真实日线，补齐原预测的逐日对照。只使用已完成 UTC 日线；当前价格差距与到期预测误差分开展示。精确目标日数据到齐后才计算最终误差，尚未到期时不提前结算。

- [最新对照报告](predictions/latest-comparison.md)：全部历史留档的最新对照。
- [完整每日 CSV](predictions/daily-comparison.csv)：包含实际日期、来源获取时间、期间价差和到期误差。
- `predictions/observations/`：每次真实请求的获取时间与价格；用于保留数据源后续修订。
- `GET /api/tracking` 与 `GET /api/tracking.csv`：对照查询及导出。原 `/api/model`、`/api/model.csv` 和 `/api/macro` 返回 410，禁止通过旧入口生成新预测。

```powershell
npm run tracking:daily       # 立即刷新真实价格并更新已有预测的对照
npm run tracking:report      # 仅从已有记录生成最新对照报告
npm run tracking:schedule    # 安装或更新 Windows 对照任务
```

旧命令 `forecast:daily`、`forecast:schedule` 和 `model:report` 保留兼容，但现在也只更新实际数据或生成对照报告。`model:report -- --refresh` 会先刷新实际日线，不再重新训练。

在线版通过 GitHub Actions 每天纽约时间 **09:23 自动更新一次**，夏令时自动调整，无需本机开机。失败保留旧数据，次日重试或在 Actions 手动补跑。代码推送仅发布已保存的数据，网页刷新读取最新发布版本。本机 Windows 定时任务已停用；上面的 `tracking:schedule` 仅供需要本机任务时手动安装。归档目录按 UTC 日期保存，另存真实获取时间与纽约日期。补跑只补齐实际数据。

原模型使用 9 项指标，外部因素候选增加 VIX、有效联邦基金利率及其变化。原模型代码与研究文件保留供审计；正常运行入口不会调用它们。历史方法与结果见 [模型验收报告](docs/模型验收报告.md) 和 [外部因素与候选模型](docs/外部因素与候选模型.md)，它们记录当时的实验，均未证明持续优于不变价基准。

## 检查

```powershell
npm test
# 先启动服务，再运行 Chrome 界面验证
npm run test:browser
```

`dashboard/public/core.mjs` 为指标计算；`dashboard/model.mjs` 为模型与时间序列回测；`dashboard/data.mjs` 为官方数据适配与缓存；`dashboard/server.mjs` 为仅监听本机的静态及 API 服务。真实数据缓存保存在忽略提交的 `.cache/` 下；刷新失败时保留原数据与时间并明确提示。界面截图与浏览器验证结果写入 `.cache/qa-selector/`。若已运行旧版服务，需重启本地服务以加载只对照模式。

原三个模拟 Demo 留在 `demos/`；调研和迭代记录分别在 `调研报告/` 与 `demos/reports/`，与新看板独立。
