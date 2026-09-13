# Adapter 合约

本文描述当前多渠道 adapter 合约。工作台当前注册 45 个 `wemedia_*` 工具；渠道 bridge 由宿主配置并在工作台之外提供，凭据、浏览器/MCP/API 依赖和外部账号状态不随本项目分发。

实现以 `src/ports/adapter.ts`、`src/domain/capability.ts`、`src/adapters/contract.ts` 和 `src/ports/channelPublishing.ts` 为准；本文是公开的接口与安全边界说明，不是账号或生产环境验收记录。

## 1. 已锁定的工作台边界

- 对外端口以 `src/ports/adapter.ts` 和 `src/domain/capability.ts` 为准；七种 action 必须区分读、本地准备、远端草稿与正式发表。
- 已有 `src/adapters/contract.ts` 要求 `wemedia.adapter-command/v1`。这是工作台内部协议，不是任何现有渠道 CLI 已承诺输出的格式。
- 原生 JSON 可在 adapter 内按已验证的形状解码并转换；不要求上游都改为工作台 schema。格式不同本身是正常适配工作，不是范围审批 blocker。
- 人类日志不能冒充结构化成功；严格 parser、版本/形状校验、有限输出、错误脱敏、取消和 deadline 不得放宽。
- 旧内容根只读；remote publish 默认拒绝，缺少本次有效批准时底层调用必须为零；排队、浏览器打开、按钮点击均不等于发布成功。

## 2. 输入与输出契约

渠道输入可以来自外部 CLI 或 bridge，但工作台只接受经版本化、严格校验的结构化结果。外部 bridge 的实现、运行时依赖和凭据由宿主单独配置，不包含在本项目中。

| 渠道 | 可接收的外部结果 | 适配边界 |
| --- | --- | --- |
| WeChat | 版本化 envelope，包含状态、错误、数据和受控素材引用 | 混合人类日志不能当作 envelope；预览、转换和草稿动作必须分别核对，降级或 `action_required` 不能冒充完成 |
| Zhihu | 结构化预检、准备、草稿或同步结果 | 只读检查、准备、草稿和正式发表必须分开；库存读取不得写旧根 |
| Xiaohongshu | 结构化预检和本地/手工准备结果 | `manual_prepare` 不等于自动填充或发表；缺少稳定远端标识时保持待核对 |
| X | 结构化预检、手工准备、队列或 API 回执 | 队列、手工交接和 API 结果分开；发表必须有帖子/线程身份和回读证据 |

## 3. 集成前置条件

### 只读、准备与发表

- `inspect`、`preflight` 和 `sync` 必须明确为只读；sync 不写旧内容根或库存。
- `prepare` 只能生成受控的本地材料；`stage`、草稿写入和正式发表必须是分开的动作，并分别声明副作用。
- 缺少结构化结果、稳定远端身份、完整回读或本次有效批准时，保持阻断或 `reconcile_required`，不能把命令退出零、页面跳转或按钮点击当作成功。

### 输出根与失败处理

- Host 为每次准备或桥接执行分配独立输出子目录；bridge 不得写入旧内容根、库存或未声明的脚本目录。
- 所有结果都要绑定当前内容修订、素材摘要、渠道和调用身份。部分提交、超时、取消和未知结果必须保留可核对状态，禁止自动重试或重复发表。
- 适配器只消费版本化 JSON；混合日志、未知字段、截断输出、错误版本和不匹配身份均应拒绝。

### 未覆盖的能力

未列出的渠道、内容类型或动作不因存在外部工具而自动获得支持。外部 bridge、浏览器/MCP/API 服务、账号和凭据均需宿主单独配置与验收，不能由本项目的接口描述推断已具备发布权限。

## 4. 外部 bridge 接入要求

外部 bridge 应提供稳定的离线预检和受控动作入口，并通过 `wemedia.adapter-command/v1` 或 `wemedia.channel-bridge/v1` 返回结构化结果。接入前至少锁定以下内容：

1. 命令参数和严格输出 schema，包括版本、状态码、错误、素材和远端证据字段。
2. 只读检查、本地准备、手工交接、远端草稿、正式发表和同步之间的准确副作用。
3. 输出根、超时、取消、控件漂移、远端证据缺失及部分提交的停止语义。
4. 离线 fixture 覆盖成功、阻断、错误版本、混合日志、超时和未知结果；真实账号或生产环境验收另行进行。

工作台不修改外部 bridge 的默认行为，也不把外部实现、模型、浏览器或平台依赖打包进 MIT 项目。

## 5. 验证入口

在隔离的开发 checkout 中执行：

- `pnpm typecheck`：类型检查。
- `pnpm test`：运行 TypeScript/Vitest 契约与回归测试。
- `npm pack --dry-run --ignore-scripts`：检查分发文件清单；不要在运行中的 DSH checkout 执行会触发 `prepare` 的安装或构建。

Python 素材辅助脚本有独立测试和依赖边界，见 [PDF 素材裁切](pdf-asset-cropping.md)。这些命令只验证本地代码或材料，不构成真实账号、平台控件或远端发表验收。

## 6. UI 与用户交互同步要求

本节定义 UI、Agent、PTC 和 Host 共享的状态语义；它不是账号或生产环境验收记录。

| 适配器证据/状态 | 用户应看到的内容 | 交互要求 |
| --- | --- | --- |
| 缺 CLI、未登录、权限不足、unsupported、degraded | 明确区分不可用、不支持与能力受限，解释安全原因 | 受影响操作禁用并说明原因；只提供实际支持的配置/重新检查/手工交接入口，不影响其他渠道 |
| 本地 prepare、AI request、queue | 已准备/排队待处理；AI 请求仍待后续处理，降级预览有标识 | 展示实际产物及下一步；打开页面或复制材料须显式操作，不显示已发表 |
| stage 或远端 draft | 区分手工交接与有远端证据的草稿 | 展示对应平台和确认事项；最终发表仍需独立批准 |
| 等待批准、正在执行 | 展示内容/渠道/目标/变更摘要与副作用，进度依据真实 Job 状态 | 防重复提交，输入变化使旧批准失效；只在可取消时提供取消，不让按钮确认冒充 Host 批准 |
| 验证/控件漂移、超时、取消、部分发表或结果未知 | 安全失败原因、已知结果和待确认部分；保留最后可信状态 | 停止自动操作，提供受控重新检查或人工核对；不得自动重新发表，也不声称取消已撤回远端操作 |
| 可信远端 ID/URL/验证证据 | 已发表及可核对证据 | 用户主动查看远端结果；同步时间与未同步状态明确，不能用脚本退出 0 或按钮点击作为发表证据 |

Queue/Detail/Channel/Job/Approval/Settings 使用同一套状态语义，不分别猜测后台成功。加载、空状态、禁用、失败与恢复均需有可理解的中文文案；关键信息不得只靠颜色，键盘焦点和禁用原因必须可访问。错误不得展示原始 stderr、凭据或机器私有路径。

合约变更必须同步修订状态映射和 fixture，并覆盖按钮权限、状态转换、窄屏和可访问性。具体 DTO 仅按既有端口向后兼容实现，不在本文虚构新返回字段。

## 7. 微信能力边界

微信是多渠道工作台中的一条渠道。下表描述应由原生工作台提供的能力与证据边界：

| 工作流 | 原生平台应提供 | 完成证据与边界 |
| --- | --- | --- |
| 素材与事实 | 来源、论文、图表和事实包的关联；可启动有范围的研究/核验任务 | 可追溯来源与当前版本的核验产物；元数据索引不等于研究已完成 |
| 写稿与修订 | 主稿/渠道稿、变更预览、人工编辑保护 | 新修订及 diff；旧稿不被静默覆盖，验收随修订失效 |
| 图表公式与预览 | 原图来源、公式渲染、微信预览和实际移动端检查入口 | 当前图片 SHA 与实际 390px 视觉证据；不能用布尔标记伪造视觉检查 |
| 质量门 | 事实、中文审读、泄漏、重复、素材、排版和渠道检查的状态及修复入口 | 显示各门的真实覆盖、阻断原因和下一步；不得把机器扫描当完整人工通读 |
| 草稿动作 | 分离新建与更新；展示账号安全标识、目标、正文/素材差异和副作用 | 一次批准、精确目标与修订绑定；已有身份优先复用，更新目标不明时不退回新建 |
| 执行与回读 | Job 进度、可取消阶段、结果待确认、在线回读与状态同步 | 远端 ID、当前版本绑定和完整必检集合；取消不等于撤销，超时不自动重发 |

共享数据流固定为 UI/RPC 或 Agent Tool → 同一应用服务 → 受控执行/微信 adapter → 证据、ledger 与投影。微信专属视图可在多渠道工作台内承载编辑预览、质量门、草稿目标、任务和回读，不能另建一套私有成功状态。正式发表始终需要独立批准，草稿已验证不等于已发表。

微信 bridge、旧工作流脚本、生产 profile 和账号写入均不随本项目分发；接入时必须保持旧内容根只读，并为任何远端动作单独声明批准与回读证据。

## 8. 原工作流复用合约

Agent、PTC 和 Client 共享 `ai_inspect`、`ai_preview`、`preview_workflow_import`、`apply_workflow_import` 用例；不复制作者/发布器逻辑，不另设模型账户。旧文件只读，本地导入只写工作台 store；没有给旧发布入口增加默认行为。

| 桥接/材料 | 精确语义 | 不得推断 |
| --- | --- | --- |
| `ai_inspect` / `ai_preview` | 临时副本调用原 CLI 固定 AI 模式与 JSON；预览输出必须属于受控临时目录；解析原 envelope 并只返回白名单诊断 | 不调用转换 API，不把 `action_required` 或 degraded 当作最终 HTML/审阅通过；不回显路径/原日志 |
| `draft_identity` | 显式允许草稿网络的配置下，只读库存；匹配当前账号、旧 media ID、原标题、官方来源和唯一单篇身份 | 不上传、不创建/更新；身份核对不执行或伪造当前内容的二十项回读 |
| `wemedia.review/v1` | 非视觉、当前完整版本、通过且含真实 findings；确认后保存对应审阅引用与 SHA | 不能一次放行四项；JSON 不能替代真实 390px PNG |
| Codex HTML 摘要 | `content_sha256` 匹配只标 partial，变化则 stale | 不证明图片、元数据或完整版本已审 |
| 静态 390 / 回读摘要 | 保留明确格式和发现；静态无完整版本绑定，回读逐项解析固定检查项 | 静态不是截图；摘要不是在线核验 |
| 草稿摘要 | 唯一 article ID/media ID、官方来源一致；上传映射仅解析摘要旁对应身份的文件并绑定摘要 | 创建/更新时间不代表本次写入，不按标题搜索猜测目标 |

Host 导入预览不落盘、不调用草稿接口；意图绑定调用方、运行代、十分钟期限、版本、材料 SHA、上传映射依赖、账号和已有目标。确认时重读并在 store 事务提交前再次核对材料/映射与当前账号；冲突、重复、取消或变化均不建立部分绑定。材料输出只含受控相对引用和严格安全字段，远端 ID、账号身份和上传映射留在 Host 私有状态。账号切换后旧绑定不能用于其他账号。

这些条目只定义复用接口的输入、输出和边界。离线 fixture 结果不能替代平台账号、控件或远端回读验收；外部 bridge 和原工作流实现由宿主独立维护。


## 9. 多渠道桥接接口

统一端口为 `src/ports/channelPublishing.ts`，平台动作和远端身份校验位于 `src/domain/channelPublishing.ts`、`src/domain/channelRemote.ts`；`src/adapters/channelBridge.ts` 负责受控进程和严格输出解码。微信原协议及草稿动作保持独立。用户、Agent 和 PTC 共用应用服务、持久 Job、结果账本与一次性意图，没有第二套发布队列。

### 工具与副作用

工作台当前注册 45 个 `wemedia_*` 工具；以下四项负责多渠道动作。参数中的 `channel` 为 `zhihu | xiaohongshu | x`，`action` 为 `prepare | stage | publish | sync`。

| 工具/RPC operation | 公开参数 | 行为 |
| --- | --- | --- |
| `wemedia_channel_inspect` / `channel_inspect` | `{ contentRef }` | 当前保存版本、能力矩阵、已绑定目标和 Job；不登录、不发表 |
| `wemedia_channel_preflight` / `channel_preflight` | `{ contentRef, channel, online? }` | 默认离线；`online:true` 只读核对账号，不打开编辑器或写旧库存 |
| `wemedia_channel_preview_action` / `channel_preview_action` | `{ contentRef, channel, action, targetRef?, targetUrl? }` | 返回 `intent/gates/summary/target`；不执行准备或发表 |
| `wemedia_channel_start_action` / `channel_start_action` | `{ intentId }` | 消费当前调用身份的精确意图，返回持久 Job；使用 `wemedia_get_job` / `wemedia_cancel_job` |

`targetRef` 与 `targetUrl` 互斥；URL 只允许 `sync`，须是该平台规范作品链接，不含认证参数、片段、其他端口或模糊跳转。ID、摘要、账号绑定、输出路径和批准引用均由 Host 提供，不能从 RPC 注入。公开 preflight 不接受内部桥协议的 `action` 字段。

| 平台与类型 | prepare | stage | publish | sync |
| --- | --- | --- | --- | --- |
| 知乎文章、图文 | 新独立本地包 | 新空编辑器，远端草稿写入；重载验证 | 已绑定当前版本的精确草稿，独立正式发表批准 | 精确目标 GET；需要已有可信内容摘要，不写旧库存 |
| 知乎视频 | 不支持 | 不支持 | 不支持 | 不支持 |
| 小红书文章 | 独立本地材料 | 本地手工交接 | 先制作图文/视频稿 | 不能用文章绕过图文/视频核验 |
| 小红书图文、视频 | 独立本地材料 | 本地手工交接 | 调用真实 MCP 发布接口；缺可信 ID 时待核对 | 按明确 ID/URL 核对本人作品、正文、类型和媒体数量/结构 |
| X 文章、图文、视频 | 普通帖子/线程材料 | 本地手工交接 | API 提交与逐帖回读；文章不代表 X Articles | 精确帖子/线程、作者、回复链及已登记媒体证据核对 |

小红书上游结果缺少稳定作品 ID 时，桥保持 `reconcile_required`；媒体回读不是原字节证明。平台类型、长度、媒体、权限或控件变化仍可阻断，支持协议不保证任一稿件可直接发表。未列出的渠道或内容类型不因存在外部工具而自动获得支持。

### 独立桥协议和结果证据

三个新入口是外部 `wemedia_bridge.mjs`，通过一份有界 stdin JSON 接收 `schemaVersion:"wemedia.channel-bridge/v1"`、`channel`、`operation` 与 `network:"disabled"|"enabled"`。文档投影包括 `contentRef/publicationType/revisionDigest/title/body/html/assets/coverSource`；每个资产绑定 `source`、受控 `artifact:{rootId,relativePath}`、SHA、类型和字节数。Host 注入授权根、独立输出子目录及所需的账号/目标/批准引用。

内部桥 preflight 可另有 `action`，供应用服务按实际计划动作检查。远端 `authorization` 为 `{action:"stage"|"publish",inputDigest,reference}`，其中桥的 `inputDigest` 绑定文档修订；DSH 原生批准则绑定完整 intent 输入，包含完整内容投影、账号与目标。不得把桥字段当成自行批准的入口。

stdout 只允许严格的版本化结果：`schemaVersion/channel/operation/adapterVersion/ok/code/configured/permission?/accountRef?/status?/revisionDigest?/verifiedAt?/remoteWriteAttempted/reconcileRequired/issues/artifacts/remote?`。未知字段、混合人类日志、截断、错误版本或身份不符都失败。非零退出可承载合法 `ok:false` 的部分提交结果；退出零、页面跳转、MCP success 或按钮点击不构成发表证据。

结果按动作限制：prepare 仅 `prepared`；知乎 stage 仅经验证 `draft`，小红书/X stage 仅 `manual_handoff`；publish 只有完整回读才 `published`；sync 必须零远端写入。成功结果不能同时待核对。`draft/published` 必须有当前修订、明确匹配的账号、规范作品 URL 和核验时间；已有目标的 ID、完整线程 ID 顺序及内容摘要不能被替换或丢弃。未知结果即使尚未观察到写入，也可要求 reconciliation。

原稿和原素材只读；prepare/stage 材料写入 Host 分配的全新独立子目录。知乎仅向空编辑器追加本次内容，已有正文不清空；视频拒绝、控件漂移、平台验证、错误作者、内容/图片对象/封面差异均停止。三个桥不运行旧库存写入脚本，也不自动重试部分发表。

### 配置边界

以下是 DSH 原生插件配置字段示例，所有路径均为待替换占位符，不是一份可直接加载的 profile。`command` 指向外部 bridge 的脚本路径，文件名必须为 `wemedia_bridge.mjs`，不是 shell 命令或旧发布 CLI。Host 使用当前 Node 执行，`cwd` 可省略并采用脚本目录，超时范围 1000～300000 ms。

```yaml
dataDir: "<isolated-state-dir>"
writeRoot: "<isolated-write-root>"
writeRootEnabled: true
adapters:
  zhihu:
    enabled: true
    command: "<external-bridge-dir>/wemedia_bridge.mjs"
    cwd: "<external-bridge-dir>"
    timeoutMs: 180000
  xiaohongshu:
    enabled: true
    command: "<external-bridge-dir>/scripts/wemedia_bridge.mjs"
    cwd: "<external-bridge-dir>"
    timeoutMs: 180000
  x:
    enabled: true
    command: "<external-bridge-dir>/src/wemedia_bridge.mjs"
    cwd: "<external-bridge-dir>"
    timeoutMs: 180000
```

内容根继续由 `roots` 声明只读范围。桥和其浏览器/MCP/API 依赖不随工作台分发；配置启用后仍须按具体稿件预检。凭据只按宿主配置引用，不写入公共示例、工具参数、分发包或日志。外部实现保留其自身来源和许可证，不因工作台采用接口而重新许可。

### 批准、恢复与身份边界

本地准备、只读检查在用户已有授权范围内直接执行，不要求额外的远端批准。知乎 stage 和所有 publish 由当前 Agent 申请 DSH 原生单次批准；意图绑定会话、运行代、十分钟期限、完整内容、素材、账号与目标，在异步等待后和实际调用前再次核验。用户界面意图不能由另一会话消费；需由当前 Agent 对同一具体内容和目标重新预览。

Job 的 queued/running/waiting_user 不代表完成，取消不代表撤回。未知结果保留已知身份与证据并禁止重发；用已有 targetRef 或用户取得的标准作品 URL 预览只读 sync，再执行其精确意图。失败的 sync 不解除既有发表/待核对状态的防重限制，不能按标题猜 ID。缺知乎草稿摘要或 X 完整线程证据时，URL 本身不足以通过核验。

配置中的账号身份只能作为本次意图和远端证据的绑定信息，不能由接口描述推断登录、发布权限或线上控件已验收。
