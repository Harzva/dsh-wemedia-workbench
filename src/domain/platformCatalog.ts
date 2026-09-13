import { cloneJson } from "./json.ts";
import type { JsonObject } from "./json.ts";

export type PlatformFormat = "article" | "image_text" | "video" | "short_text";
export type PlatformId = "instagram" | "threads" | "youtube" | "bilibili" | "douyin" | "tiktok" | "pinterest" | "facebook";
export type PlatformReferenceId = "meta-business-sdk" | "postiz" | "googleapis" | "biliup";

export interface PlatformSource extends JsonObject {
  label: string;
  url: string;
}

export interface PlatformCatalogEntry extends JsonObject {
  id: PlatformId;
  name: string;
  formats: PlatformFormat[];
  status: "research_only";
  priority: "first" | "later" | "restricted";
  summary: string;
  requirements: string[];
  limitations: string[];
  sources: PlatformSource[];
  referenceIds: PlatformReferenceId[];
}

export interface PlatformReference extends JsonObject {
  id: PlatformReferenceId;
  repository: string;
  url: string;
  commit: string;
  license: string;
  reuse: string;
}

export interface PlatformCatalog extends JsonObject {
  schemaVersion: "wemedia.platform-catalog/v1";
  researchedAt: "2026-09-09";
  notice: string;
  platforms: PlatformCatalogEntry[];
  references: PlatformReference[];
}

const catalog: PlatformCatalog = {
  schemaVersion: "wemedia.platform-catalog/v1",
  researchedAt: "2026-09-09",
  notice: "以下为平台能力与接入条件研究，尚未接入本工作台的发布流程。参考版本记录不代表当前机器已安装、账号已授权或内容已发布。",
  platforms: [
    {
      id: "instagram", name: "Instagram（Ins）", formats: ["image_text", "video"], status: "research_only", priority: "first",
      summary: "适合单图、轮播图文和 Reels，可复用现有图文与视频稿件。",
      requirements: [
        "需要 Business 或 Creator 专业账号及 Meta App 的有效授权。",
        "需授权账号资料与内容发布权限；若选择 Facebook 登录，还需绑定 Page 并完成对应授权。",
        "标准图片和视频 URL 必须可由 Meta 访问，本地路径和回环地址不能直接使用。",
      ],
      limitations: [
        "不提供与知乎长文章等价的纯文本文章发表；文章转图卡或摘要须单独确认。",
        "图片格式、轮播数量及视频规格须按实际接口预检；Stories 按登录路线和 Business 账号权限单独验收。",
        "视频断点续传仍待核验；媒体处理完成不等于公开发布。",
      ],
      sources: [
        { label: "Meta 官方 Instagram 发布与登录说明", url: "https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-ab559ffb-8e2c-4b0a-b43a-5737b6d2f672" },
        { label: "Meta 官方 Reels 示例", url: "https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-f83ffcaa-55ed-4357-932d-3a61ccbc084a" },
      ],
      referenceIds: ["meta-business-sdk", "postiz"],
    },
    {
      id: "threads", name: "Threads", formats: ["short_text", "image_text", "video"], status: "research_only", priority: "first",
      summary: "适合研究摘要、讨论串、单图与混合媒体轮播。",
      requirements: [
        "需要为 Meta 应用启用 Threads、准备 Threads 账号并单独授权。",
        "需授权账号资料与内容发布权限，并配置平台允许的登录回调地址。",
        "标准图片和视频 URL 需可由 Meta 访问，Instagram 登录状态不能替代 Threads 授权。",
      ],
      limitations: [
        "普通帖文、长文附件和讨论串需要分别适配，不能静默截断完整文章。",
        "自动发布文本会直接发表，不能用于本地准备或仅暂存内容。",
        "正式发表与回读是独立步骤；账号范围、审核要求和媒体额度需按实际应用复核。",
      ],
      sources: [
        { label: "Meta 官方 Threads API", url: "https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api" },
        { label: "Meta 官方 Threads 示例", url: "https://github.com/fbsamples/threads_api" },
      ],
      referenceIds: ["postiz"],
    },
    {
      id: "youtube", name: "YouTube", formats: ["video"], status: "research_only", priority: "first",
      summary: "适合完整视频与短视频，先处理上传、私有可见性和转码回读。",
      requirements: [
        "Google Cloud 项目需启用 YouTube Data API，并由目标频道所属用户 OAuth 授权。",
        "需授权视频上传，并确认目标频道、标题、说明及私有或公开可见性。",
      ],
      limitations: [
        "受审计限制的项目上传仅能私有可见，上传成功不能标为公开视频。",
        "文章和图文不是视频；生成视频应形成独立稿件。",
        "配额、素材规格与处理状态应实时核对，不照搬参考项目的默认值。",
      ],
      sources: [
        { label: "Google 官方视频上传接口", url: "https://developers.google.com/youtube/v3/docs/videos/insert" },
        { label: "Google 官方配额与审核说明", url: "https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits" },
        { label: "Google 官方视频与处理状态", url: "https://developers.google.com/youtube/v3/docs/videos" },
      ],
      referenceIds: ["googleapis"],
    },
    {
      id: "bilibili", name: "哔哩哔哩（B 站）", formats: ["video", "article"], status: "research_only", priority: "first",
      summary: "优先适配视频投稿；专栏文章按独立能力接入。",
      requirements: [
        "开放平台路线需要开发者身份审核、应用权限和 UP 主授权。",
        "客户端登录态投稿与开放平台 OAuth 是不同路线，应分别配置与核对账号。",
      ],
      limitations: [
        "投递被接受不等于审核通过或公开可见，需精确稿件 ID 与审核状态回读。",
        "当前详细投稿权限、配额和专栏契约仍需在实际应用中复核；动态图文尚未核实。",
        "biliup 参考源码存在许可证与 README 使用说明差异，本轮仅借鉴流程。",
      ],
      sources: [
        { label: "B 站开放平台文档", url: "https://open.bilibili.com/doc" },
        { label: "B 站开发者服务协议", url: "https://open.bilibili.com/agreement/developer-service" },
      ],
      referenceIds: ["biliup"],
    },
    {
      id: "douyin", name: "抖音", formats: ["image_text", "video"], status: "research_only", priority: "restricted",
      summary: "可研究视频与图文代发；未获得开放平台能力时先准备手工发布材料。",
      requirements: [
        "需要申请代替用户发布内容的开放平台能力，并获得相应应用权限及用户 OAuth 授权。",
        "视频与图文发布权限应分别申请、分别核验。",
      ],
      limitations: [
        "创建作品后仍有平台审核，提交成功不等于公开发表。",
        "SDK 拉起抖音编辑页、浏览器自动化与 OpenAPI 代发是不同操作。",
        "账号已有登录态不等于应用具备代发权限。",
      ],
      sources: [
        { label: "抖音官方创建视频接口", url: "https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-create" },
        { label: "抖音官方代发能力目录", url: "https://developer.open-douyin.com/capacity-center-page/capacity-detail/7224121299067469881" },
      ],
      referenceIds: [],
    },
    {
      id: "tiktok", name: "TikTok", formats: ["image_text", "video"], status: "research_only", priority: "restricted",
      summary: "区分直接发表与交到收件箱继续编辑，优先明确应用准入条件。",
      requirements: [
        "直接发表与收件箱上传需要分别申请平台能力，并获得用户授权。",
        "需读取创作者可用选项并确认隐私和互动设置；照片来源需通过域名或地址前缀验证。",
      ],
      limitations: [
        "未审计 Direct Post 受私有可见等限制；仅供本人或内部团队管理账号的工具不符合其公开的目标用途要求。",
        "Upload API 交到收件箱后仍由用户在 TikTok 中完成发表，不是已公开发布。",
        "视频与照片传输方式不同；处理完成和正式发布结果必须分别核对。",
      ],
      sources: [
        { label: "TikTok 官方内容分享规范", url: "https://developers.tiktok.com/docs/en/content-sharing-guidelines" },
        { label: "TikTok 官方 Direct Post 入门", url: "https://developers.tiktok.com/docs/en/content-posting-api-get-started" },
        { label: "TikTok 官方收件箱上传", url: "https://developers.tiktok.com/docs/en/content-posting-api-get-started-upload-content" },
      ],
      referenceIds: [],
    },
    {
      id: "pinterest", name: "Pinterest", formats: ["image_text", "video"], status: "research_only", priority: "later",
      summary: "适合以封面、摘要和原文链接形成 Pin，图片优先、视频随后。",
      requirements: [
        "需要企业账号，并授权图钉和画板的对应读写权限。",
        "公开使用需要相应接入级别；视频需先注册和上传媒体，处理成功后创建 Pin。",
      ],
      limitations: [
        "Trial 创建的内容仅创建者可见，不能按公开发布统计。",
        "Sandbox 不支持视频 Pin；完整文章需要单独转换为摘要、封面与来源链接。",
        "媒体上传成功与 Pin 创建成功是不同状态。",
      ],
      sources: [
        { label: "Pinterest 官方接入级别", url: "https://developers.pinterest.com/docs/key-concepts/access-tiers/" },
        { label: "Pinterest 官方创建 Pin", url: "https://developers.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/" },
        { label: "Pinterest 官方 Sandbox", url: "https://developers.pinterest.com/docs/developer-tools/sandbox/" },
      ],
      referenceIds: [],
    },
    {
      id: "facebook", name: "Facebook Page", formats: ["short_text", "image_text", "video"], status: "research_only", priority: "later",
      summary: "适合 Page 文本、链接、图片和视频 / Reels，可与 Meta 授权配置共用基础设施。",
      requirements: [
        "需要目标 Page 的管理权及授权；应用审核与具体发布权限须单独核验。",
        "应明确选择目标 Page、媒体形式及未公开、定时或公开状态。",
      ],
      limitations: [
        "Page API 不等于个人主页自动发帖，也不是富文本文章编辑器。",
        "视频创建、上传、处理和发表应独立记录；SDK 有方法不证明当前账号有调用权限。",
        "当前权限明细和视频规格尚需复核，不能以旧样例限制替代实时接口检查。",
      ],
      sources: [
        { label: "Meta 官方 Facebook API 集合", url: "https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api" },
        { label: "Meta 官方 Page SDK 固定版本", url: "https://github.com/facebook/facebook-python-business-sdk/blob/5286888addfe3ba3718db65fbf132bd66de3ddfe/facebook_business/adobjects/page.py" },
      ],
      referenceIds: ["meta-business-sdk"],
    },
  ],
  references: [
    {
      id: "meta-business-sdk", repository: "facebook/facebook-python-business-sdk",
      url: "https://github.com/facebook/facebook-python-business-sdk/tree/5286888addfe3ba3718db65fbf132bd66de3ddfe",
      commit: "5286888addfe3ba3718db65fbf132bd66de3ddfe", license: "Meta Platform Policy license（仓库自定义许可）",
      reuse: "核对 Instagram / Page 请求字段与媒体回读；生成方法存在源间差异，不能直接当作发布验收。",
    },
    {
      id: "postiz", repository: "gitroomhq/postiz-app",
      url: "https://github.com/gitroomhq/postiz-app/tree/36d5fc7b3ac3f17178b1589cf7a7337523017a41",
      commit: "36d5fc7b3ac3f17178b1589cf7a7337523017a41", license: "AGPL-3.0",
      reuse: "借鉴 Instagram / Threads 容器处理与发表阶段划分；未复制实现代码，个人主页回退不能作为作品回执。",
    },
    {
      id: "googleapis", repository: "googleapis/google-api-nodejs-client",
      url: "https://github.com/googleapis/google-api-nodejs-client/tree/7916cf7e4cf670500b7c881c6ab44742a050c413",
      commit: "7916cf7e4cf670500b7c881c6ab44742a050c413", license: "Apache-2.0",
      reuse: "借鉴 YouTube 文件流、私有上传和元信息；账号权限、可恢复记录与正式回读需独立实现。",
    },
    {
      id: "biliup", repository: "biliup/biliup",
      url: "https://github.com/biliup/biliup/tree/906e0f6fdb104d65989d12b76c9a6f02205384cb",
      commit: "906e0f6fdb104d65989d12b76c9a6f02205384cb", license: "根 LICENSE 为 MIT；README 含禁商用说明，待厘清",
      reuse: "仅研究上传与稿件字段；客户端登录态路线不是开放平台 OAuth，令牌刷新不能放进只读账号检查。",
    },
  ],
};

export function getPlatformCatalog(): PlatformCatalog {
  return cloneJson(catalog);
}
