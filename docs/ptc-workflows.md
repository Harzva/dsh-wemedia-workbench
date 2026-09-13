# Agent、PTC 与工作台

分工固定为：Agent 研究、写作、判断内容质量与审阅图片；DSH 原生 PTC (`run_code`) 编排工具、批量检查和筛选结果；工作台负责文章版本、审阅材料、一次性意图、审批、Job 与结果记录。

工作台不提供第二套代码沙箱、任务调度器或模型账户，也不切换全局 `native` / `code` / `both` 模式。部署已启用 PTC 时，同一组注册工具自动进入 DSH 生成的 SDK；普通调用与 PTC 子调用均走 DSH 原生策略流水线，再调用同一个 `WorkbenchService`。界面也调用该服务，不能提交 `approved` 或伪造 Agent 身份。

## 本地公式 PNG

`python3 -B scripts/render-formulas.py formulas.json --output <新的输出目录>` 使用 Python 的 `matplotlib`、`numpy`、`Pillow`，通过 MathText 的 STIX 字体生成白底 3× PNG；不启动浏览器、外部 TeX 或网络。默认字号为 20 CSS px，图片宽度最多 318 CSS px、内边距 8 px。过长的行直接报错，请按数学含义拆行，不自动缩成小字。目录必须不存在；最多 16 个公式，每个最多 8 行。

输入示例（仅为合成演示，来源字段由作者填写）：

```json
{"formulas":[{"basename":"example-equation","lines":["E = \\sum_{i=1}^{n} p_i x_i^2"],"source":{"url":"https://example.org/synthetic-formula","page":1,"section":"Synthetic example"},"alt":"合成公式示例"}]}
```

`lines` 不含 `$` 分隔符；中文符号解释保留在文章 HTML 中。输出包含 PNG 和 `source-map.json`，记录 LaTeX、来源、渲染版本及图片 SHA-256。按其中 `cssWidth` 显示图片，并设 `max-width:100%;height:auto`；不要把 3× 像素宽度直接当成显示宽度。把输出放在已配置写入根内，后续仍通过现有素材、保存和 `images_formulas` 审阅接口处理。输出只证明完成数学排版，来源声明与公式事实仍需独立核对；不会自动成为审阅证据或触发上传。

## 可以直接复用的工具

当前注册 45 个 `wemedia_*` 工具；`run_code` 由 DSH 提供，不计入工作台工具数。公式脚本不增加工具或 RPC。

| 用途 | 工具 | 副作用 |
| --- | --- | --- |
| 内容库与素材 | `wemedia_library_list`、`wemedia_library_read`、`wemedia_library_media` | 只读；opaque itemId 和有界媒体分块 |
| 媒体发布稿读取 | `wemedia_publication_read`、`wemedia_publication_media` | 只读；作品与素材摘要分别校验 |
| 媒体发布稿建稿与修订 | `wemedia_create_publication`、`wemedia_preview_publication_save` | 先预览，使用 start_action 保存本地版本 |
| 渠道状态与预检 | `wemedia_channel_inspect`、`wemedia_channel_preflight` | 只读；可显式在线核对账号，不证明发布权限 |
| 渠道操作 | `wemedia_channel_preview_action`、`wemedia_channel_start_action` | 精确意图；本地准备、远端草稿与正式发表分别处理 |
| 多渠道批量预检 | `wemedia_batch_preflight` | 只读；最多 20 篇 × 4 渠道，逐项隔离 |
| 主稿与来源关系 | `wemedia_mapping_inspect`、`wemedia_mapping_preview`、`wemedia_mapping_apply` | 读取／预览／一次本地映射提交，不写原稿 |
| 多根设置 | `wemedia_setup_inspect`、`wemedia_setup_preview`、`wemedia_setup_apply` | 读取／预览／原生设置提交，随后重连核对 |
| 配置与能力 | `wemedia_snapshot`、`wemedia_refresh` | 读取；refresh 更新本地索引 |
| 版本与材料详情 | `wemedia_history`、`wemedia_compare_versions`、`wemedia_evidence_detail` | 只读；仅当前文章已登记身份 |
| 资料与文章 | `wemedia_search_contents`、`wemedia_inspect_content` | 只读 |
| 检查与预览 | `wemedia_preflight`、`wemedia_preview` | 只读，不代替内容/图片审阅 |
| 原 CLI AI 诊断 | `wemedia_ai_inspect`、`wemedia_ai_preview` | 受控临时输入/输出；固定 AI 模式，不调用模型或上传 |
| 原工作流复用 | `wemedia_preview_workflow_import`、`wemedia_apply_workflow_import` | 预览只读；确认记录本地材料；草稿须先只读身份核验 |
| Agent 任务 | `wemedia_task_brief` | 为已保存文章/视频/图文返回当前版本任务说明，不新建 Agent |
| 创建文章 | `wemedia_create_content` | 先预览；应用意图才写入独立目录 |
| 修订、打包、草稿和核对 | `wemedia_preview_action`、`wemedia_start_action` | 意图绑定；草稿写入需 DSH 原生批准 |
| 审阅证据 | `wemedia_record_review` | 记录当前版本的真实材料引用 |
| 任务与取消 | `wemedia_get_job`、`wemedia_cancel_job` | 读取状态／请求取消；不是回滚 |

工具返回 `{ ok: true, value, revision }` 或 `{ ok: false, error }`，其中搜索页、质量问题、版本、意图和 Job 都有明确输出 schema。不能把 `ok: true` 的排队结果等同于任务完成；必须检查 Job 的终态。

## 只读平台扩展目录

`wemedia_platform_catalog({})` 无参数，返回八个平台的格式、接入条件、限制、官方来源和参考信息。UI 与 Native/PTC 读取同源目录；`status` 只能是 `research_only`。这些平台不在 `channel` 发布枚举中，不能因目录存在而调用发布、复用其他平台授权或推断账号权限。目录冷调用也不触发适配器初始化、账号发现或任务恢复。

## 多渠道预览、执行和核对

四个新工具的公开参数如下。`channel` 仅为 `zhihu | xiaohongshu | x`；`contentRef` 必须来自已保存文章或发布稿，不能用库素材 ID 或路径代替。

| 工具 | 参数 | `value` 主要字段 |
| --- | --- | --- |
| `wemedia_channel_inspect` | `{ contentRef }` | `revisionDigest/publicationType/capabilities/matrix/targets/jobs/issues` |
| `wemedia_channel_preflight` | `{ contentRef, channel, online? }`，默认 `online:false` | `revisionDigest/configured/permission/gates` |
| `wemedia_channel_preview_action` | `{ contentRef, channel, action, targetRef?, targetUrl? }` | `intent/channel/action/publicationType/gates/target/summary` |
| `wemedia_channel_start_action` | `{ intentId }` | 持久 `WorkbenchJob`，随后用 `wemedia_get_job` 查询 |

`action` 是 `prepare | stage | publish | sync`。`targetRef` 与 `targetUrl` 互斥；`targetUrl` 只用于 `sync`，必须是用户从平台取得、不含认证参数或片段的标准作品链接。路径、账号指纹、远端 ID、上传摘要和批准引用均由 Host 绑定，不能自行添加到工具参数。公开 preflight 不接受 `action` 参数；操作预览会额外运行该动作需要的检查。

- 知乎支持文章/图文，不支持视频。`prepare` 是本地材料；`stage` 新建并填入空编辑器，属于远端草稿写入；`publish` 必须选择已有、当前版本的精确草稿目标与读回摘要，不覆盖其他编辑器内容。
- 小红书文章只允许本地 `prepare` 和手工 `stage`；自动发表先制作图文或视频稿。上游提交没有可信作品 ID 时保持待核对；按明确 URL 回读账号、正文、类型和媒体数量/结构，不证明媒体原字节一致。
- X 的文章是普通帖子线程；图文/视频按平台媒体检查处理，不声称拥有 X Articles 权限。`stage` 仅手工交接，发表后须核对全部已知帖子 ID、作者、回复链和媒体证据。

平台账号和权限状态属于运行时数据，必须在执行前由宿主重新检查；接口或离线 fixture 均不能推断当前登录状态或发布权限。

以下代码块分开执行。首先读取能力并预览一个本地准备动作：

```typescript
const contentRef = "<已保存文章或发布稿的 contentRef>";
const state = await tools.wemedia_channel_inspect({ contentRef });
if (!state.ok) return state;
return await tools.wemedia_channel_preview_action({
  contentRef, channel: "zhihu", action: "prepare",
});
```

展示返回的 `summary`、`gates` 和精确变更；在已有用户授权范围内审阅具体预览，阻断时先处理原因。然后用同一调用身份、同一会话的精确意图执行，不重新生成替代意图：

```typescript
const started = await tools.wemedia_channel_start_action({
  intentId: "<本会话刚才已审阅且无阻断的 intentId>",
});
if (!started.ok) return started;
return { jobId: started.value.jobId, status: started.value.status };
```

`queued/running/waiting_user` 均非完成；读取终态及 `resultCode`：

```typescript
return await tools.wemedia_get_job({ jobId: "<上一步返回的 jobId>" });
```

知乎 `stage` 或任一渠道 `publish` 使用相同的分步模式，并由当前 Agent 等待 DSH 原生单次批准。用户界面产生的意图不能交给另一 Agent 消费；当前会话须重新预览同一内容/版本/账号/目标，展示其具体意图后申请批准。批准绑定整个输入，等待期间或执行前内容、素材、账号、目标、运行代或期限变化都会阻断。不要循环调用 publish，不绕过平台验证或控件漂移。

提交结果未知时，保留 Job 和已有目标证据。优先使用 `channel_inspect.targets[]` 中属于该内容及渠道的 `targetRef` 预览 `sync`；没有可用 ID 时，使用用户提供的标准作品链接：

```typescript
return await tools.wemedia_channel_preview_action({
  contentRef: "<该次提交的 contentRef>", channel: "xiaohongshu",
  action: "sync", targetUrl: "<用户从平台取得的标准作品链接>",
});
```

核对该只读预览后仍用 `channel_start_action` 与 `get_job`。sync 不申请远端写批准，不改旧库存；核验成功可提交本地身份绑定。失败不会解除既有“已发表/待核对”的防重复提交状态。知乎未知 URL 缺少可信草稿内容摘要时仍会阻断；已知目标通过 URL 核对会保留原摘要。X 多帖须有完整线程身份，不能用一个根帖链接代替缺失的全部发布证据。取消只请求停止，不撤销可能发生的发表。

## PTC 示例：只把存在问题的文章交给 Agent

以下代码用于已有 DSH PTC 会话，不是独立脚本或后台自动化。最多检查 100 篇，每组并发 4 个只读检查；工作台没有专用批量执行引擎。DSH 仍负责每个子调用的策略和并发规则。

```typescript
const problems = [];
let cursor: string | undefined;
let checked = 0;
let complete = false;

for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
  const page = await tools.wemedia_search_contents({
    query: "",
    pageSize: 20,
    ...(cursor ? { cursor } : {}),
  });
  if (!page.ok) return { checked, complete: false, problems, error: page.error };

  for (let offset = 0; offset < page.value.items.length; offset += 4) {
    const group = page.value.items.slice(offset, offset + 4);
    const results = await Promise.all(group.map(async (article) => {
      try {
        const result = await tools.wemedia_preflight({ contentRef: article.contentRef });
        if (!result.ok) return { contentRef: article.contentRef, title: article.title, error: result.error };
        if (result.value.status === "pass") return null;
        return {
          contentRef: article.contentRef,
          title: article.title,
          revisionDigest: result.value.inputDigest,
          issues: result.value.issues.filter(issue => issue.status !== "pass"),
        };
      } catch {
        // DSH policy rejection/runtime failure is different from a gate block.
        return { contentRef: article.contentRef, title: article.title, error: { code: "TOOL_CALL_FAILED" } };
      }
    }));
    checked += group.length;
    problems.push(...results.filter(result => result !== null));
  }
  cursor = page.value.nextCursor ?? undefined;
  if (!cursor) { complete = true; break; }
}
return { checked, complete, problems, ...(cursor ? { nextCursor: cursor } : {}) };
```

这里返回的是需要审阅的摘要，不打印正常文章的完整正文、图片数据或中间检查结果。`CURSOR_STALE` 表示索引变化，应重新查询，不能混用两代列表；续跑前还应重新确认文章版本。

## 复用已有报告与草稿

先读取文章的 `workflowImports` 和当前有效 `reviews`，再选择已配置根目录下的具体 JSON 材料；不要重写原报告只为转换格式。调用 `wemedia_preview_workflow_import({ contentRef, kind: "review", artifact: { rootId, relativePath } })` 得到来源、SHA、版本、findings、警告和一次性意图，核对后才用 `wemedia_apply_workflow_import({ intentId })` 确认。返回的是更新后的文章，不是 Job；不能将其传给 `wemedia_start_action`。用户与 Agent 的导入意图不能互相消费，Agent 意图还绑定原生执行身份。

- `current` 只说明该种材料的绑定有效：仅当前 `wemedia.review/v1` 非视觉通过报告可确认到对应审阅项，不自动补齐其他三项。
- `partial`、`historical`、`stale` 是继续核验的材料，不是当前审阅通过。HTML 摘要不覆盖图片版本，静态 390 检查不是截图，历史草稿回读不是当前在线核验。
- `kind: "draft"` 只支持已知的草稿摘要及明确命名上传映射；确认先按账号、旧 ID、原标题和来源核验唯一单篇草稿，再保存本地绑定。无账号或无法核验时不绑定、不猜目标、不新建。
- 身份通过不设置当前正文已验证。随后可按既有 `sync` 用例核对二十项；远端更新须重新预览并走 DSH 原生批准。
- `wemedia_ai_inspect` / `wemedia_ai_preview` 返回安全诊断与 fidelity，不返回原始 HTML、日志或临时路径。缺 Markdown 时明确使用 HTML 输入并保留降级；用 `wemedia_preview` 查看工作台保存版本的 390px 预览。

## 版本比较与完整审阅

`wemedia_history({ contentRef })` 返回最近 100 个已登记版本的 ID、正文修订与 Markdown 摘要、登记时间和可读状态。保存成功才加入索引；接入前的孤立目录不自动认领。`wemedia_compare_versions({ contentRef, fromId, toId })` 可比较任意两个可读登记版本，返回公开字段/HTML/Markdown 差异和素材新增、移除、字节变化；复制重命名按素材 SHA 匹配，不假报新增。修改或缺失的历史文件会拒绝比较，不提供覆盖恢复操作。

通过 `wemedia_inspect_content` 获取 `paragraphs`、`assets`、`reviews`、`workflowImports`，然后用已登记 ID 调用 `wemedia_evidence_detail({ contentRef, evidenceId })`。阅读器校验原材料 SHA，返回完整受支持正文、来源/页码/图号、逐条事实、公式源码与产物 SHA，或安全的 PNG 数据。旧批量回读只显示本篇唯一匹配行的 20 项公开检查；不回显账号、上传身份、路径或原始诊断。材料改变时先报 `EVIDENCE_CHANGED`，不显示新字节。

非视觉报告保留 `wemedia.review/v1` 的 `kind`、`revisionDigest`、`verdict: "pass"` 和具体 `findings`。完整覆盖需要附加以下严格 `details` 结构（此处仅为字段示例；须填写实际审阅结果及完整范围）：

```typescript
const details = {
  body: "完整的纯文本审阅报告，由审阅者按实际结果填写",
  markdownDigest: "sha256:<当前 Markdown 字节的 SHA-256>",
  sources: [{ id: "paper", title: "第一手论文", url: "https://example.org/paper", page: "3", figure: "Figure 2" }],
  facts: [{ id: "fact-1", paragraph: 1, claim: "本段待核对的事实", disposition: "supported", sourceIds: ["paper"], note: "说明来源如何支持该事实" }],
  paragraphs: [1],
  assets: [{ source: "assets/figure.png", digest: "sha256:<inspect 返回的素材摘要>", kind: "original", sourceIds: ["paper"], formulaSource: "", note: "原论文对应页及图号" }],
};
```

`paragraph`/`paragraphs` 使用 `inspect_content.paragraphs` 的一基编号，包含标题、列表项等可定位正文块。事实覆盖要求每个正文块有实际事实记录，或 `disposition: "not_applicable"`、空 `sourceIds` 和明确非事实说明；中文审读使用 `paragraphs`；原图/公式覆盖要求每个当前素材的 `source + digest` 均登记。原图的引用须有页码与图号；公式素材的 `kind: "formula"` 还须记录非空 `formulaSource` 和来源。来源、事实和素材标识不能重复或悬空。覆盖只说明审阅者登记范围，不自动证明真实或完整提取了所有事实。

旧版只有 findings 的报告仍可阅读、登记，但不满足新增的三个覆盖门；部分覆盖也不放行。Markdown 单独变化同样使扩展报告和批准失效，即使为兼容旧桥接，原 `revisionDigest` 仍采用元数据 + HTML + 图片字节算法。移动视觉材料要求 390px 宽、200～20000px 高、CRC 与像素数据可解码的非交错 PNG；阅读时移除附加元数据。合成测试 PNG 不能用于宣称真实文章视觉审阅通过。

## 可靠执行边界

- PTC 局部变量是临时状态，不能当作版本库、持久队列或恢复记录。持久动作由工作台返回 Job ID，后续调用按 ID 查询。
- 草稿创建和更新共用一次性、带到期时间的意图；批准后仍重新核对版本、完整内容投影、素材、质量证据、账号和目标。微信的原 start_action 不提供正式发表；正式发表使用独立 channel_* 工具，没有批量发布入口。
- 只读 `sync` 核对已绑定目标，不申请草稿写权限；它仍要核对账号、目标和版本。
- 工具策略拒绝、业务阻断、超时和远端未知结果分别处理。取消不撤回已发生的副作用；`reconcile_required` 禁止自动重复创建草稿。
- 机器检查不代替 Agent 审阅。文章变更后旧证据失效；论文结果表默认保留原论文截图，不能把重新排版的数字表当成原图。

工作台任务页会在页面可见且有进行中任务时有限跟踪状态（串行读取，最多 200 次），隐藏或关闭即暂停/清理；也可手动刷新。这个 Client 观察器不会重试写入，不改变原生 PTC 或 Host Job 的执行语义。保存前可查看原生差异，保存成功只表示版本落盘，不表示审阅通过或草稿已就绪。
- 界面需要研究、写作、审阅或远端写批准时，把明确任务交给当前 DSH 会话，沿用其模型、工具和原生审批。没有当前会话时提示选择，不暗中创建会话。

## 验证与状态

本文件记录接口与使用方式，不据此声明账号、平台控件或生产 profile 已验收通过。执行前必须根据当前运行时状态重新预检，并保留与当前版本绑定的证据。

## 按渠道和时间筛选，再做隔离预检

`timeField` 可选 `updated`、`created`、`published`，默认 `updated`。保留的 `updatedFrom/updatedTo` 参数名表示当前所选时间字段的半开范围；必须传带时区的 ISO 时间。`channel` 与状态、发布时间组合时只采用该渠道证据；没有正式发布证据的内容不会因文件 mtime 而匹配发布时间。会议、年份、标签、关键词和其他条件均取交集，游标绑定所有条件及数据版本。

```typescript
const page = await tools.wemedia_library_list({
  publicationType: "article", category: "arxiv", channel: "zhihu",
  timeField: "updated", pageSize: 20,
});
if (!page.ok) return page;
// mappingRef 只用于来源关联；只读素材/旧稿不能冒充可检查的发布稿。
const refs = [...new Set(page.value.items.flatMap(item => {
  const ref = item.publicationRef ?? item.contentRef;
  return ref ? [ref] : [];
}))];
if (!refs.length) return { checked: 0, issues: page.value.issues };
const checked = await tools.wemedia_batch_preflight({
  contentRefs: refs, channels: ["wechat", "zhihu", "xiaohongshu", "x"],
});
if (!checked.ok) return checked;
return { cancelled: checked.value.cancelled,
  problems: checked.value.results.filter(item => item.status !== "pass") };
```

每项保留自己的内容身份、修订、渠道、状态和原因。一个渠道未接入或一篇稿件失败，不改变其他项结论。`pass` 不是审阅证据或发布批准；具体操作能力以 channel_inspect 的平台/类型/动作矩阵为准，不能把本地准备/草稿当成正式发表。

## 创建本地发布稿，确认后执行精确意图

以下三个代码块是分开的会话步骤。首先只预览；将标题、类型、内容和预期变更展示给用户审阅。`create_publication` 支持 `video | image_text`，文章仍用 `wemedia_create_content` 和原编辑流程。

```typescript
return await tools.wemedia_create_publication({
  publicationType: "image_text", title: "待制作的论文图文",
});
```

用户确认具体预览后，在同一调用身份/会话中使用刚才返回的精确 `intentId`，不要重新生成一个意图来代替用户审阅的版本：

```typescript
const started = await tools.wemedia_start_action({
  intentId: "<刚才已审阅的 intentId>",
});
if (!started.ok) return started;
return { jobId: started.value.jobId, contentRef: started.value.contentRef,
  status: started.value.status };
```

再根据返回的 Job ID 只读核对终态；`queued/running` 不是完成，`failed/reconcile_required` 不能自动重试写入。初始空稿可保存但仍显示缺图、缺视频或其他未准备好的问题。

```typescript
return await tools.wemedia_get_job({ jobId: "<上一步返回的 jobId>" });
```

完成后使用 `wemedia_publication_read({ contentRef })` 获取当前版本。编辑时，`wemedia_preview_publication_save({ contentRef, expectedRevision, edit })` 的 `expectedRevision` 必须来自当前整篇发布稿；`edit` 只含 `title/body/media/coverItemId/channels`。每个 `media` 仅含 `source/itemId/revisionDigest/caption`，不得把完整输出资产对象原样当编辑参数。保存预览同样交用户审阅，再用其精确意图调用 `start_action` 和 `get_job`。

图文最多 18 张图片；视频稿最多一段视频和一张图片封面，每个素材最多 64 MiB、总量最多 128 MiB。标题最多 200 字符、正文 30000、每图说明 1000；媒体、封面和目标渠道都是修订内容。`readOnlySource:true` 的已保存稿可浏览，必须先在设置中重新启用原写根才能保存。

## 素材身份和来源映射

| 使用位置 | 标识与摘要来源 |
| --- | --- |
| 内容库素材读取 | `library:*` itemId 和该 LibraryItem 的 revisionDigest；`library_media` 每块最多 262144 字节 |
| 编辑选入原素材 | `source:"library"`，使用已确认的 library itemId 及其摘要，Host 再读原文件并复制到新版本 |
| 编辑保留已保存素材 | `source:"draft"`，使用 `publication_read.media[]` 的 `publication-asset:*` itemId 及该资产自身 revisionDigest |
| 发布稿媒体分块 | `publication_media` 使用作品 contentRef、上述 asset itemId，以及**整篇发布稿**的 revisionDigest；返回也绑定整篇修订 |
| 来源关系入口 | 标准文章 contentRef 或库项目的 mappingRef；不要用素材 itemId 或机器路径代替 |

每个版本中的资产不可变；顺序、说明、封面或正文改变都会产生新的整篇修订。文件替换、缺失、素材来源不可用及不匹配摘要有明确错误，不能继续拼接两代媒体分块；PTC 临时变量不是持久恢复记录。

`mapping_inspect({ contentRef, query?, cursor?, pageSize? })` 给出候选 sourceRecordId、主稿与渠道版本、冲突、dirty/stale。`mapping_preview` 的业务动作必须放在嵌套 `change.operation` 内，例如：

```typescript
return await tools.wemedia_mapping_preview({ change: {
  contentRef: "<已读取的 contentRef 或 mappingRef>",
  operation: "select_canonical",
  sourceRecordIds: ["<属于该文章的 sourceRecordId>"],
}});
```

确认后使用 `mapping_apply({ intentId })`，它直接返回本地提交结果，不能交给 `start_action`。`map_variant` 另需 `channel` 和有效主稿；`bind` 需 2～50 份来源且包含当前身份；`separate` 需当前全部来源和明确的 `retainedSourceRecordIds`，当前主稿留在旧身份。关联只保存来源摘要和基线，不改正文，不迁移旧 ledger、发布历史和远端目标。dirty 版本拒绝覆盖或自动重认基线；先人工保留、另行安排独立关联，没有 `force` 参数或自动重生成。

## 已配置目录的选择

`setup_inspect({})` 只返回候选 ID、标签、可用性和当前选择。`setup_preview({ rootIds, writeRootId })` 中写根选 `"write"` 或 `null`；确认后单独调用 `setup_apply({ intentId })`，不使用 `start_action`。预览绑定调用身份、配置 generation、目录身份和期限，提交后连接可能重载，先回读新的 generation 与选择再做后续操作。

候选路径留在 Host，不能从工具提交任意路径。写根开关使用 `writeRootEnabled`，缺省 true；停用保留原候选和已保存稿件的只读访问，重新选择可恢复写入。新目录仍由 DSH 原生插件配置添加。Notifier 默认 no-op，通知缺失、超时或失败不改变已持久化 Job 的业务结果，也不会自动发送外部消息。

## 已保存媒体稿的当前会话协作

`wemedia_task_brief({ contentRef, action: "research" | "write_draft" | "review" })` 也支持已保存的视频/图文，沿用现有 TaskBrief DTO，没有新增工具。把返回的当前修订任务交给用户正在使用的 DSH 会话及其模型/工具；没有会话时先选择，不暗建 Agent 或模型账户。媒体审阅结论目前留在会话中，不通过文章专用 `record_review` 协议冒充媒体审阅证据。保存本地修订与正式发表仍分别核对。该入口只提供模型复用任务说明，不声明模型调用或远端验收结果。
