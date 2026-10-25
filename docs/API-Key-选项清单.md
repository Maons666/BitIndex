# BitIndex API Key 选项清单

核对日期：2026-10-18（纽约）。**当前看板的 12 项指数、原预测模型，以及已接入 VIX/EFFR 的外部因素候选模型均无需 API Key。以下均是可选升级，尚未接入、没有发起订阅。**

| 服务 | 可以解决什么 | 当前是否必需 | 权限要点与入口 |
|---|---|---|---|
| FRED / ALFRED | 广义美元、实际利率、流动性、宏观历史发布版本 | 否。当前 VIX/EFFR 使用原始发布方免费接口 | 需注册免费 API Key；历史版本覆盖依序列而定。[Key 说明](https://fred.stlouisfed.org/docs/api/api_key.html) · [历史版本日期](https://fred.stlouisfed.org/docs/api/fred/series_vintagedates.html)。本次公开 CSV 路径返回 404，未用不明镜像替代 |
| Glassnode | 用其官方序列替换 MVRV、Puell、NUPL；以后可扩展 MVRV Z-Score、SOPR | 否。当前用 Coin Metrics 真数据与公开定义 | 需确认目标指标、历史长度和调用额度。官方文档目前说明完整 API 面向 Professional，Advanced 的 Light API 仅 14 天历史、日频、50 次/日。[官方 API 说明](https://docs.glassnode.com/basic-api/api-key) · [创建 Key](https://studio.glassnode.com/settings/api) |
| CoinGlass | 直接使用其 AHR999 序列，减少本地均值口径与平台数值的差异 | 否。当前从真实日线本地复算 | AHR999 端点文档列出 Hobbyist 至 Enterprise 均可用；需 API 套餐及 `CG-API-KEY`。[AHR999 端点](https://docs.coinglass.com/reference/ahr999) · [API 套餐](https://www.coinglass.com/pricing) |
| Coin Metrics Network Data Pro | 扩展数据范围、服务保障或商用授权 | 否。当前需要的 PriceUSD、HashRate、IssTotNtv、IssTotUSD、CapMVRVCur 已验证可通过 Community 访问 | Pro 与 Community 是不同端点及授权。需要升级时先核对指标覆盖及许可。[API 文档](https://docs.coinmetrics.io/api/v4/) · [咨询](https://coinmetrics.io/contact/) |

## 如何决定

- 保持免费、个人使用：维持当前方案即可。
- 要求图表数值和 Glassnode 对齐：优先决定是否接入 Glassnode。只有最近 14 天的权限不足以替换看板完整历史，不能仅根据“有 Key”判断可用。
- 要求 AHR999 与 CoinGlass 页面一致：再选 CoinGlass。不同价格源、均值与拟合版本会造成差异。
- 准备面向客户商用或公开分发：另行核对数据许可；有 API Key 不自动代表有转售或再分发权。当前 Community 数据保留来源标识。

套餐价格以官方页面或报价为准，此处不预填易过期的金额。

## 后续接入位置

确认后在 `dashboard/data.mjs` 增加对应适配器，凭据仅在本地服务进程读取；不会写入前端代码、URL、导出文件或浏览器存储。建议环境变量名：`GLASSNODE_API_KEY`、`COINGLASS_API_KEY`、`COINMETRICS_API_KEY`；**这些只是预留名称，当前版本尚未读取它们**。

| 指标 | 可选官方端点 | 认证方式 |
|---|---|---|
| MVRV | `https://api.glassnode.com/v1/metrics/market/mvrv?a=BTC&i=24h` | `X-Api-Key` 请求头 |
| Puell Multiple | `https://api.glassnode.com/v1/metrics/indicators/puell_multiple?a=BTC&i=24h` | `X-Api-Key` 请求头 |
| AHR999 | `https://open-api-v4.coinglass.com/api/index/ahr999` | `CG-API-KEY` 请求头 |

“江卓尔挖矿成本指数”目前没有已核实的原始公式或官方接口；不能通过购买一个通用 Key 保证得到它。当前实现明确标注为固定参数电费模型。

ETF 资金流、全市场资金费率、未平仓合约和强平历史可继续评估 CoinGlass 等官方端点，接入前需要逐项确认覆盖起始日、数据口径与套餐权限。当前候选模型未使用这些数据。FRED 未来预留环境变量名 `FRED_API_KEY`，当前尚未读取或保存任何该服务凭据。
