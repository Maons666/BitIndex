# GitHub Pages 部署

网站：https://maons666.github.io/BitIndex/

仓库：https://github.com/Maons666/BitIndex

工作流：https://github.com/Maons666/BitIndex/actions/workflows/pages.yml

使用公开仓库、GitHub 托管的标准 Linux runner 和 Pages，不使用付费服务、外部数据库或 API Key。页面上的刷新读取最新发布版本，不触发即时后台取数。需要立即更新时，仓库拥有者可在 Actions 的工作流页面点击 Run workflow。

## 代码与数据

- `main`：源代码、测试、部署工作流与说明。
- `tracking-data`：`predictions/` 保存原预测、输入快照、实际值、每日对照及运行记录；`cache/` 保存官方历史日线缓存。
- Pages 发布目录仅含页面资产、行情 JSON、精简的对照 JSON 和 CSV，不包含本机任务配置、磁盘路径、原输入快照或完整模型参数。

14 份原预测按原字节迁移，`forecast-lock.json` 保存各文件 SHA-256。后台更新前后均检查数量和内容，发现新增、删除或改动即停止发布。不重新训练，不生成新预测。

每天的真实数据与对照通过提交保存到数据分支；下次运行先恢复数据分支，再追加记录。实际价格首次记录后固定，后续修订保存在独立 observations 中。GitHub Actions 的临时缓存、运行容器和发布 artifact 都不作为唯一存储。页面的市场数据和对照数据使用同一个内容版本，避免混用不同批次。

## 自动执行

每小时第 23 分钟检查，在纽约时间 09:00 后获取最新完整 UTC 日线；本日已成功获得该完整日线时跳过重复取数。推送主分支或手动执行会立即尝试更新。失败保留旧数据及原获取时间，发布页显示更新失败状态，之后重试。GitHub 调度可能延迟，网页显示实际数据日期，不保证准点。

公开仓库长期没有活动可能被 GitHub 停用定时工作流；请留意 Actions 页面。每天产生的数据提交通常会保持仓库活动，但不以此承诺调度永不中断。

本机 Windows 定时任务仍只更新本机 `predictions/`；云端更新数据分支，两者不会互相改写。本机归档可继续作为原始备份。要获取云端追加的对照记录，请下载或检出 `tracking-data` 分支。

## 本地构建与验证

```powershell
npm test
npm run build:pages
npm run preview:pages
# 另一个终端，验证真实 /BitIndex/ 子路径
npm run test:pages
```

默认构建读取本机 `.cache/coinmetrics-btc.json` 和 `predictions/`。云端通过 `BITINDEX_CACHE_DIR` 与 `BITINDEX_TRACKING_DIR` 指向数据分支。构建产物为 `dist/`，不提交到主分支。保留 `npm start` 的本地实时刷新功能。

参考：[GitHub Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[Actions 定时执行限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。
