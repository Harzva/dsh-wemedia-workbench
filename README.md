# dsh-wemedia-workbench

面向 DeepSeek Harness 的本地优先自媒体工作台：AI 整理内容，工作台管理修订、审阅证据、审批与渠道任务。

A local-first media workbench for DeepSeek Harness, with revision-bound reviews,
explicit approvals and persistent delivery jobs.

**状态：早期开发版源码。** 当前锁定 DSH `0.1.1-rc.2` / Cordis `4.0.1`，
不承诺兼容其他版本。渠道桥接代码不等于真实账号发帖已验收；默认配置不包含
内容目录、凭据或已启用的远端适配器。本项目不是 DeepSeek 官方产品。

## 当前能力

- 本地内容库：只读发现文章、图像和视频，支持筛选、来源映射和独立写根。
- 文章模板：论文精读、系列总导航、专题合集、TPAMI、Nature 系列和开源工作流介绍；可预览章节并创建独立本地提纲，保留空白稿。
- 文章与媒体稿件：不可变修订、素材绑定、差异预览和未保存修改保护。
- 审阅证据：事实、编辑、图片与公式、手机视觉四类证据绑定具体修订和文件字节。
- DSH 协作：原生工具与 PTC 共用应用服务，沿用当前会话的模型和工具权限。
- 持久任务：预检、一次性操作意图、原生审批、Job 状态与目标回读；未知结果先核对，不盲目重发。
- 批量微信草稿：发送选中或全库待发送文章，先确认清单，再交给当前 Agent 逐篇审批和投递；可查看逐篇结果、停止队列。
- 多渠道接口：微信公众号、知乎、小红书、X 的适配器契约和工作台操作入口；运行桥、登录环境和账号由使用者另行配置。
- 素材辅助：确定性公式渲染与 PDF 图表裁剪脚本，保留来源及 SHA，不自动下载 MinerU 模型。

内容入口使用与当前 DSH 结构匹配的 DOM 兼容层，不是官方一级导航 Slot；
结构不匹配时回退到附加入口。其他平台目录仅供接入研究，不代表发布能力。

## 工作流

1. 从授权的本地素材和论文来源整理内容，保留引用。
2. 通过原生工作流保存修订；原始文件保持只读。
3. 检查事实、措辞、图片和公式，实际查看手机预览，登记当前版本证据。
4. 冻结正文、素材和报告，逐篇预检并预览拟执行动作。
5. 对准确动作进行原生审批，再执行和跟踪同一个 Job。
6. 回读目标和当前修订。草稿箱成功不等于正式发布。

AI 参与整理应在文章中明确披露。模型名称不是默认必填的逐篇字段，失败稿件
也无需额外维护模型归属表；但修订、任务和远端结果仍须保留必要记录，避免
重复提交。可复用经验进入工作流文档，私有执行记录不随源码公开。
详见 [AI 整理与工作流公开](docs/ai-assisted-workflow.md)。

论文与微信解读索引：[Awesome AI Paper Notes](https://github.com/Harzva/awesome-ai-paper-notes)。
目录按 CVPR、AAAI、TPAMI、Nature 系列组织，缺失公开链接不等于文章未发表；
它是独立的公开内容项目，不会随插件安装自动导入或发布。

## 开发

需要 Node.js `>=22.19.0` 和 pnpm `10.16.1`。

```sh
git clone https://github.com/Harzva/dsh-wemedia-workbench.git
cd dsh-wemedia-workbench
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

`prepare` 会构建本地 `lib/`。不要在被运行中 DSH 直接加载的源码目录内升级、
构建或验证发布包；使用独立检出和隔离 profile。仓库不分发账号桥、密钥、
Cookie、文章库、模型订阅或模型权重。安装源码也不会自动配置发布账号。

### CLI 与 PTC

当前**没有统一的 `wemedia` CLI**。批量微信草稿通过工作台与同源原生工具提供，
不是独立 CLI，也不是无审批的批量发布命令。
DSH 原生工具和 PTC 是工作流入口；PTC 需宿主已启用对应工具模式。
`wemedia_batch_preflight` 只做只读预检，不创建草稿或正式发布。
两个 Python 脚本是本地素材辅助工具，不是另一套发布引擎。

批量草稿每次最多 50 篇。“待发送”读取全库当前 `ready` 文章，不受当前页
分页影响；超过上限会明确要求分批，不静默截断。已入箱、已有旧目标、审阅
缺失或结果待核对的文章分别跳过或阻断。每次推进最多启动一个原生任务，
版本和账号变化会阻断该项；拒绝审批、取消或不确定结果会停止后续队列。
批次 `completed` 只表示清单处理完毕，必须逐项统计成功与未发送的文章。

后续 CLI 应薄封装同一应用服务，沿用身份、版本、审批和 Job 契约，不能另建
绕过审批的存储或执行路径。

### 可选 Python 工具

- `scripts/render-formulas.py`：使用独立安装的 Matplotlib 渲染公式。
- `scripts/crop-pdf-asset.py`：使用独立安装的 PyMuPDF 裁剪图表，支持明确的页面点、渲染像素、归一化和 MinerU 坐标。

这些依赖不随源码捆绑，也不会由脚本自动安装。依赖适用各自许可证，尤其
PyMuPDF 并非 MIT；详见 [第三方说明](THIRD_PARTY_NOTICES.md)。

## 文档

- [适配器契约](docs/adapter-contract.md)
- [PTC 工作流](docs/ptc-workflows.md)
- [执行经验与恢复边界](docs/workflow-lessons.md)
- [PDF 图表裁剪](docs/pdf-asset-cropping.md)
- [公式排版](docs/formula-typesetting.md)
- [AI 整理与工作流公开](docs/ai-assisted-workflow.md)
- [贡献指南](CONTRIBUTING.md) / [安全说明](SECURITY.md)

## 许可证

项目源码采用 [MIT](LICENSE)。保留已有贡献者和复用代码的版权声明。
外部依赖、平台服务、论文、图片、字体和模型权重不因本仓库开源而变成 MIT。
