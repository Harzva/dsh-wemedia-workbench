import type { JsonObject } from "./json.ts";

export const ARTICLE_TEMPLATE_IDS = ["blank", "paper-deep-dive", "series-index", "topic-index", "tpami-review", "nature-review", "workflow-showcase"] as const;
export type ArticleTemplateId = (typeof ARTICLE_TEMPLATE_IDS)[number];
export interface ArticleTemplate extends JsonObject {
  id: ArticleTemplateId;
  version: number;
  label: string;
  kind: "paper" | "article" | "any";
  sections: { title: string; prompt: string }[];
}

const sources = { title: "原文、代码与 AI 整理说明", prompt: "待补：原文与作者代码的公开链接；按实际参与情况说明 AI 辅助整理。仅在确有人工审核时声明人工审核。" };
const paperOpening = [
  { title: "论文介绍", prompt: "待补：论文原题、会议或期刊、年份，以及一句话导读。" },
  { title: "作者与团队", prompt: "待补：依据论文署名核对作者、所属单位；没有可靠来源的团队背景不写。" },
  { title: "摘要提炼", prompt: "待补：研究问题、核心方法和主要发现，区分论文结论与解读。" },
  { title: "引言与研究动机", prompt: "待补：问题背景、已有方法的不足和本文切入点。" },
];
const methods = { title: "方法与关键图示", prompt: "待补：方法流程、必要公式及符号；原图须核对图号、页码和来源，不能用示意图冒充论文原图。" };
const experiments = { title: "实验与表格解读", prompt: "待补：数据集、指标、基线、主要结果和消融；表格须对应原文，手机端补充可读的关键结果，无表格时不强行添加。" };
const limits = { title: "总结与局限", prompt: "待补：主要贡献、适用条件、局限和仍未回答的问题。" };
const directory = { title: "论文与微信解读目录", prompt: "待补：从已核对的系列目录逐条列出原题、主题、论文链接、微信公开文章链接和作者代码。缺少微信链接时标记待补，不使用草稿或临时预览地址，不编造已发布状态。" };

const TEMPLATES: readonly ArticleTemplate[] = [
  { id: "blank", version: 1, label: "空白稿", kind: "any", sections: [] },
  { id: "paper-deep-dive", version: 1, label: "论文精读 · CVPR / AAAI", kind: "paper", sections: [...paperOpening, methods, experiments, limits, sources] },
  { id: "series-index", version: 1, label: "系列总导航", kind: "article", sections: [
    { title: "系列介绍与收录范围", prompt: "待补：系列、年份、筛选标准、读者和更新时间；只按去重清单报告篇数，不将专题选文称为会议全部论文。" },
    { title: "研究方向与阅读路线", prompt: "待补：按方向组织专题入口，说明各方向的研究问题。" },
    directory,
    { title: "Awesome 与工作流", prompt: "待补：实际存在的开源目录和制作工具链接；区分文章已完成、已入草稿箱和已正式发布。" },
    sources,
  ] },
  { id: "topic-index", version: 1, label: "研究专题合集", kind: "article", sections: [
    { title: "专题与问题背景", prompt: "待补：专题边界、筛选依据和共同研究问题。" },
    { title: "方法分类与对比", prompt: "待补：根据论文证据比较研究路线、假设与评测设置，不直接比较不同设置下的分数。" },
    directory,
    { title: "推荐阅读顺序与开放问题", prompt: "待补：基础工作、进阶工作和待解决问题；将阅读建议与客观实验结果分开。" },
    sources,
  ] },
  { id: "tpami-review", version: 1, label: "TPAMI 长文解读", kind: "paper", sections: [...paperOpening,
    { title: "期刊版本与前序工作", prompt: "待补：DOI、在线发表或卷期信息；仅在有证据时说明与会议版本的关系及新增内容。" },
    methods, experiments,
    { title: "复现条件与证据边界", prompt: "待补：代码可用性、训练与评测条件、计算资源及尚未复核的结论。" },
    limits, sources,
  ] },
  { id: "nature-review", version: 1, label: "Nature 系列解读", kind: "paper", sections: [...paperOpening,
    { title: "期刊与研究类型", prompt: "待补：具体期刊全名、DOI和研究类型；不能把 Nature 子刊写成 Nature 主刊。" },
    { title: "研究设计与关键图示", prompt: "待补：假设、数据或样本、实验设计、对照与关键原图；区分相关性、因果证据及适用人群或场景。" },
    experiments,
    { title: "科学意义与外推限制", prompt: "待补：结果支持的范围、不确定性和局限；不把研究发现直接转为诊疗建议或未经验证的产品效果。" },
    sources,
  ] },
  { id: "workflow-showcase", version: 1, label: "开源工作流介绍", kind: "article", sections: [
    { title: "项目与使用场景", prompt: "待补：项目名称、实际仓库地址、适用对象与已支持的能力。" },
    { title: "资料到文章的工作流", prompt: "待补：来源整理、AI 辅助、图表裁剪、修订、核对与草稿投递的真实流程。" },
    { title: "可复现示例", prompt: "待补：脱敏输入、可重复的步骤和已验证输出；未执行的步骤注明未验证。" },
    { title: "权限、失败恢复与限制", prompt: "待补：审批边界、未知结果回读、防重复提交和当前限制。" },
    { title: "开源范围与参与方式", prompt: "待补：许可证、依赖边界和贡献入口；不公开账号、密钥、日志或未授权素材。" },
    sources,
  ] },
];

export function articleTemplates(): ArticleTemplate[] {
  return TEMPLATES.map(template => ({ ...template, sections: template.sections.map(section => ({ ...section })) }));
}
export function articleTemplate(id: ArticleTemplateId): ArticleTemplate {
  const template = articleTemplates().find(item => item.id === id);
  if (!template) throw new Error("Unknown article template");
  return template;
}
const escapeHtml = (value: string): string => value.replace(/[&<>"']/gu, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const escapeMarkdown = (value: string): string => value.replace(/[\r\n]+/gu, " ").replace(/[\\`*_{}\[\]()<>#!|]/gu, "\\$&");

/** Deterministic scaffolds only: no invented facts, links, assets or review evidence. */
export function renderArticleTemplate(id: ArticleTemplateId, title: string, sourceUrl: string): { markdown: string; html: string } {
  const template = articleTemplate(id);
  if (id === "blank") return { markdown: `# ${title}\n`, html: `<h1>${escapeHtml(title)}</h1><p>请完成资料研究和文章正文。</p>` };
  const marker = `wemedia-template:${template.id}@${template.version}`;
  const sections = [{ title: "来源", prompt: sourceUrl || "待补：原始来源公开链接。" }, ...template.sections];
  return {
    markdown: `<!-- ${marker} -->\n\n# ${escapeMarkdown(title)}\n\n${sections.map(section => `## ${section.title}\n\n${escapeMarkdown(section.prompt)}`).join("\n\n")}\n`,
    html: `<!-- ${marker} --><h1>${escapeHtml(title)}</h1>${sections.map(section => `<h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.prompt)}</p>`).join("")}`,
  };
}
