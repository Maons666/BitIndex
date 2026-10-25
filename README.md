# BitIndex · Bitcoin 指数看板

当前主入口是 `dashboard/`：12 项 Bitcoin 指数选择叠图，以及历史预测与实际价格对照。**已停止新增预测**；刷新和定时任务只更新真实价格与对照结果。数据来自真实的 Coin Metrics Community API，无需 API Key。

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

自动任务每天纽约时间 09:00 起执行，失败按小时重试，并在登录时检查漏跑；需要电脑开机、联网且用户已登录，无需打开网页。归档目录按 UTC 日期保存，另存真实获取时间与纽约日期。补跑只补齐实际数据。

原模型使用 9 项指标，外部因素候选增加 VIX、有效联邦基金利率及其变化。原模型代码与研究文件保留供审计；正常运行入口不会调用它们。历史方法与结果见 [模型验收报告](docs/模型验收报告.md) 和 [外部因素与候选模型](docs/外部因素与候选模型.md)，它们记录当时的实验，均未证明持续优于不变价基准。

## 检查

```powershell
npm test
# 先启动服务，再运行 Chrome 界面验证
npm run test:browser
```

`dashboard/public/core.mjs` 为指标计算；`dashboard/model.mjs` 为模型与时间序列回测；`dashboard/data.mjs` 为官方数据适配与缓存；`dashboard/server.mjs` 为仅监听本机的静态及 API 服务。真实数据缓存保存在忽略提交的 `.cache/` 下；刷新失败时保留原数据与时间并明确提示。界面截图与浏览器验证结果写入 `.cache/qa-selector/`。若已运行旧版服务，需重启本地服务以加载只对照模式。

原三个模拟 Demo 留在 `demos/`；调研和迭代记录分别在 `调研报告/` 与 `demos/reports/`，与新看板独立。
