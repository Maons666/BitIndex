# 历史预测与真实价格对照

**当前为 comparison-only 模式，已停止新增预测。** 此目录保存原先实际发出的预测及之后获取的真实价格，独立于可清理的 `.cache/`。请备份整个目录。历史回放结果仍在 `.cache/model-report.json` 等研究文件中，不导入这里充当实际发出的预测。

```text
predictions/
  forecasts/YYYY-MM-DD/模型版本.json  首次预测、真实发出时间、参数及输入指纹
  inputs/指纹.json.gz                当时完整 BTC 输入快照
  inputs/macro-指纹.json.gz          候选模型当时的外部数据快照
  actuals/YYYY-MM-DD.json            首次获取的实际日收盘价及来源时间
  comparisons/YYYY-MM-DD/预测ID.json 各份预测在该日的对照
  observations/YYYY-MM-DD/时间_ID.json 每次真实请求的获取时间和价格
  runs/YYYY-MM-DD/时间_随机ID.json    每次运行状态与失败原因
  latest-comparison.md               最新对照报告（可再生）
  daily-comparison.csv               全部每日对照的可再生汇总
  schedule.json                      本机自动任务配置
```

目录中的日期为 UTC。预测文件另有 `issuedAt`（准确时间）、`issuedLocalDate`（纽约日期）、`prediction.date`（模型基准日）及 `prediction.targetDate`（30 日目标日），这些日期不互相替代。原先每个 UTC 发出日、每个模型版本只保存首次结果；现有预测及其输入全部保留，手动刷新和定时任务均不会新增预测。

JSON 原始记录以排他方式原子创建，重复运行、并发刷新、服务商修订都不覆盖已有记录。输入按 SHA-256 去重并 gzip 压缩。CSV 和最新报告是从不可变 JSON 生成的视图，可以重新生成。每次刷新取得的价格另存 observations；即使当天实际值已归档，也会记录本次真实获取时间，以追溯服务商修订。

## 每日执行

Windows 自动任务名按项目路径生成，记录在 `schedule.json` 中。每小时检查一次，在 **America/New_York 09:00 后**更新当天实际价格与原预测对照，成功后不重复拉取；遇到网络或数据发布延迟会在随后小时重试。夏令时按纽约时区处理。登录时也会检查。任务无需打开网页或启动网页服务器。

电脑必须开机、联网，且当前 Windows 用户已登录；此配置不会要求密码、管理员权限，也不会主动唤醒休眠电脑。关机或未登录期间无法执行，恢复后补齐已有预测所缺的实际日线。未实际产生的过去预测不会补造。

```powershell
# 手动执行一次：刷新真实 BTC 价格、更新对照，不训练模型
npm run tracking:daily

# 安装或更新此项目的自动任务
npm run tracking:schedule

# 仅移除此项目的自动任务，不删除档案
npm run tracking:schedule -- -Remove
```

网页“刷新数据”“更新实际数据”也会更新实际价格与对照。原留档包含 `ridge-30d-v1` 和 `ridge-30d-macro-v1`；不再拉取宏观因子或重新计算任何预测。数据源未发布最新完整日线时标记 delayed 并重试，断网时保留旧记录并标记 stale。旧 forecast 命令仍可用，但行为同样为只更新对照。

## 如何比较

每天记录实际价格、相对预测基准日的涨跌幅，以及与 30 日预测目标价的差距。`targetGapPct` 是尚待达到的目标差距，**不是提前结算的预测误差**。

只有实际日线日期精确等于 `targetDate` 才标记 `settled` 并计算：

- `errorPct = (预测价/实际价−1)×100`，正值为高估。
- `absoluteErrorPct = |预测价/实际价−1|×100`。
- `baselineErrorPct = |基准日价格/实际价−1|×100`。
- `directionCorrect` 判断相对基准日的方向是否一致，`intervalHit` 判断到期价是否落入预测区间。

未到期及缺失目标日数据的预测保持待验证，误差为 `null`，CSV 留空。不能拿到期前后最近价格替代。首次实际价格一经保存也不跟随服务商后续修订，以便保留当时所见结果。原先每天留档的 30 日预测彼此重叠，因此到期样本并不独立；不会把样本数直接解释为置信度。

页面“历史预测对照”可查看最近 60 份记录和分模型统计。`GET /api/tracking` 提供汇总，`GET /api/tracking.csv` 导出全部逐日比较；首批预测尚未到期时不会给出虚构准确率。
