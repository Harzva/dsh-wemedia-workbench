import type { JsonObject } from "./json.ts";

export type ArticleCategory = "conference" | "arxiv" | "other";
export interface ArticleTaxonomy extends JsonObject {
  category: ArticleCategory;
  conference: string | null;
  year: number | null;
  tags: string[];
}
export interface ArticleFacets extends JsonObject {
  categories: Array<{ value: ArticleCategory; count: number }>;
  conferences: Array<{ value: string; count: number }>;
  years: Array<{ value: number; count: number }>;
  tags: Array<{ value: string; count: number }>;
}

/** Only short, public labels can become taxonomy or filter values. */
export function isTaxonomyLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 80 && value === value.trim() && !value.startsWith(".") &&
    !/[\u0000-\u001f\u007f<>\\]/u.test(value) && !/(?:https?:|file:|\/(?:Users|Volumes|private|home|etc)\/|(?:token|secret|password|cookie|authorization|api.?key)\s*[:=])/iu.test(value);
}
const scalar = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { const decoded: unknown = JSON.parse(trimmed); if (typeof decoded === "string") return decoded; } catch { /* Not a JSON quoted scalar. */ }
  }
  return trimmed.startsWith("'") && trimmed.endsWith("'") ? trimmed.slice(1, -1).replaceAll("''", "'") : trimmed;
};
const stringList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.slice(0, 32).flatMap(item => typeof item === "string" ? [item] : []);
  if (typeof value !== "string" || value.length > 4096) return [];
  const source = value.trim();
  if (source.startsWith("[") && source.endsWith("]")) {
    try { const parsed: unknown = JSON.parse(source); if (Array.isArray(parsed)) return stringList(parsed); } catch { /* YAML inline strings below. */ }
    return source.slice(1, -1).split(/,(?=(?:[^"']|"[^"]*"|'[^']*')*$)/u).map(scalar).slice(0, 32);
  }
  return [scalar(source)];
};

/** A deliberately small, bounded frontmatter reader; no YAML tags, aliases or evaluation. */
export function readArticleFrontmatter(markdown: string): Record<string, unknown> {
  const text = markdown.slice(0, 32_768).replace(/^\ufeff/u, "").replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(text);
  if (!match) return {};
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let pending: string | undefined;
  for (const line of match[1]!.split("\n").slice(0, 300)) {
    const key = /^([A-Za-z][A-Za-z0-9_]{0,63}):\s*(.*)$/u.exec(line);
    if (key) {
      pending = key[1]!;
      if (["__proto__", "constructor", "prototype"].includes(pending)) { pending = undefined; continue; }
      const raw = key[2]!.trim();
      values[pending] = !raw ? [] : raw.startsWith("[") ? stringList(raw) : scalar(raw);
    } else if (pending && /^\s*-\s+\S/u.test(line)) {
      const list = values[pending];
      if (Array.isArray(list) && list.length < 32) list.push(scalar(line.replace(/^\s*-\s+/u, "")));
    } else if (line.trim() && !line.trim().startsWith("#")) pending = undefined;
  }
  return values;
}

const VENUE = /(?:^|[^a-z])(AAAI|IJCAI|CVPR|ICCV|ECCV|ICML|ICLR|NeurIPS|NIPS|EMNLP|NAACL|ACL|COLM|KDD|SIGIR|SIGGRAPH|WWW|ACM[-_ ]?MM)(?:[-_ ]?((?:19|20)\d{2}|\d{2}))?(?=$|[^a-z])/iu;
const venueName = (name: string): string => /^(?:nips|neurips)$/iu.test(name) ? "NeurIPS" : /^acm[-_ ]?mm$/iu.test(name) ? "ACM MM" : name.toUpperCase();
const sourceText = (value: unknown): string => stringList(value).join(" ").slice(0, 4096);
const yearValue = (value: unknown): number | null => {
  const year = typeof value === "number" ? value : typeof value === "string" && /^(?:19|20)\d{2}$/u.test(value) ? Number(value) : NaN;
  return Number.isInteger(year) && year >= 1900 && year <= 2099 ? year : null;
};
const topicLabels: Record<string, string> = {
  tool: "工具调用", memory: "记忆", planning: "规划推理", reasoning: "规划推理", multiagent: "多智能体",
  "multi-agent": "多智能体", multimodal: "多模态", safety: "安全", generation: "生成", embodied: "具身智能",
};

/** Read only source declarations before the first section or inside its core-information block. */
function introductoryVenues(markdown: string, title: string): { venues: RegExpExecArray[]; ambiguous: boolean } {
  const text = markdown.slice(0, 12_000).replace(/^\ufeff/u, "").replaceAll("\r\n", "\n").replace(/^---\n[\s\S]*?\n---(?:\n|$)/u, "");
  const found: RegExpExecArray[] = [];
  let coreInformation = false, fenced = false;
  const articleSubject = title.split(/[：:｜|]/u)[0]!.trim().toLocaleLowerCase();
  for (const raw of text.split("\n").slice(0, 200)) {
    if (/^\s*(?:```|~~~)/u.test(raw)) { fenced = !fenced; continue; }
    if (fenced || /^\s*>/u.test(raw)) continue;
    const line = raw.replaceAll("**", "").trim();
    const heading = line.replace(/^#{1,6}\s+/u, "").replace(/^[◆◇]\s*\d{1,2}\s*[｜|:：.、-]\s*/u, "");
    if (/^(?:参考文献|参考资料|参考来源|资料来源|参考论文|References)(?:\s|[:：]|$)/iu.test(heading)) break;
    if (/^#\s/u.test(line) && heading === title) continue;
    if (/^#{1,6}\s|^[◆◇]\s*\d|^核心信息(?:\s|[:：]|$)/u.test(line)) {
      if (!coreInformation && /^核心信息(?:\s|[:：]|$)/u.test(heading)) { coreInformation = true; continue; }
      break;
    }
    const sentence = line.replace(/^[-*]\s+/u, "").split(/[。！？!?]/u)[0]!.slice(0, 400);
    const matches = [...sentence.matchAll(new RegExp(VENUE.source, "giu"))].filter(value => value[2]);
    if (!matches.length) continue;
    const match = matches[0]!;
    const start = match.index! + match[0].indexOf(match[1]!);
    const prefix = sentence.slice(0, start).trim(), suffix = sentence.slice(match.index! + match[0].length).trim();
    const series = !coreInformation && /^(?:[A-Za-z][\w.-]{0,30}(?:\s+[A-Za-z][\w.-]{0,30})?)?$/u.test(prefix) && /^(?:论文|文章|专题)?(?:精读)?系列$/u.test(suffix);
    const sourceField = /^(?:会议|发表会议|论文会议|会议与版本|conference|venue)\s*[:：]/iu.test(sentence);
    const paperKind = /^(?:论文|(?:long\s+)?paper)(?=$|[^a-z])/iu.test(suffix);
    const thisPaper = prefix === "这篇" && paperKind;
    const assertion = /^(.*?)\s*(?:发表在|发表于|是)\s*$/u.exec(prefix);
    const subject = assertion?.[1]?.replace(/^原论文\s*/u, "").trim().toLocaleLowerCase();
    const ownsSubject = Boolean(subject && articleSubject && (subject === articleSubject || subject.startsWith(`${articleSubject}:`) || subject.startsWith(`${articleSubject}：`)));
    const directPublication = ownsSubject && (/发表(?:在|于)\s*$/u.test(prefix) || paperKind);
    if (series || sourceField || thisPaper || directPublication) found.push(...matches);
  }
  const identities = new Set(found.map(value => `${venueName(value[1]!)}:${value[2]!.length === 2 ? `20${value[2]}` : value[2]}`));
  return { venues: identities.size === 1 ? found : [], ambiguous: identities.size > 1 };
}

/** Conference identity takes precedence over an arXiv mirror; body citations do not assign venues. */
export function classifyArticle(input: { title: string; path?: string; metadata?: Record<string, unknown>; markdown?: string }): ArticleTaxonomy {
  const metadata = { ...(input.markdown ? readArticleFrontmatter(input.markdown) : {}), ...input.metadata };
  const candidates = [metadata.conference, metadata.venue, metadata.title_prefix, metadata.titlePrefix, metadata.series, input.path, input.title].map(sourceText);
  const explicitVenues = candidates.map(value => VENUE.exec(value)).filter(value => value !== null);
  const introductionVenues = explicitVenues.length ? { venues: [], ambiguous: false } : introductoryVenues(input.markdown ?? "", input.title);
  const venues = [...explicitVenues, ...introductionVenues.venues];
  const venue = venues[0];
  const conference = venue ? venueName(venue[1]!) : null;
  const datedVenue = venues.find(value => value[2] && venueName(value[1]!) === conference);
  const venueYear = datedVenue?.[2] ? yearValue(datedVenue[2].length === 2 ? `20${datedVenue[2]}` : datedVenue[2]) : null;
  const sources = [metadata.source_ids, metadata.sourceIds, metadata.source_url, metadata.sourceUrl, metadata.content_source_url, metadata.series, metadata.category, input.path].map(sourceText).join(" ");
  // Explicit arXiv identifiers near the article introduction count as article metadata.
  const introduction = (input.markdown ?? "").slice(0, 12_000).split(/\n\s*(?:#{2,6}\s|[◆◇]\s*\d|(?:\*\*)?(?:参考文献|参考资料|资料来源|References)\b|(?:\*\*)?(?:参考文献|参考资料|资料来源)(?:\*\*)?\s*(?:\n|[:：]))/iu)[0] ?? "";
  const arxiv = /(?:arxiv\s*[:：/]|arxiv\.org\/(?:abs|pdf)\/|arxiv[-_ ](?:agent|daily|论文)|arXiv Agent)/iu.test(sources) || /(?:\*\*)?arxiv(?:\*\*)?\s*[:：]\s*\d{4}\.\d{4,5}/iu.test(introduction) || /^\s*(?:[-*>]\s*)?(?:\*\*)?(?:类型|来源|版本)(?:\*\*)?\s*[:：][^\n]{0,160}\barxiv(?:\s+v\d+|\b)/imu.test(introduction);
  const category: ArticleCategory = conference ? "conference" : arxiv && !introductionVenues.ambiguous ? "arxiv" : "other";
  const arxivId = /(?:arxiv\s*[:：]\s*|arxiv\.org\/(?:abs|pdf)\/)(\d{2})\d{2}\.\d{4,5}/iu.exec(`${sources} ${introduction}`);
  const pathYear = /(?:^|[/_-])((?:19|20)\d{2})(?:[-_/]|$)/u.exec(input.path ?? "")?.[1];
  const year = yearValue(metadata.conference_year ?? metadata.year) ?? venueYear ?? (category === "arxiv" && arxivId ? yearValue(`20${arxivId[1]}`) : yearValue(pathYear));
  const tags: string[] = [];
  const add = (value: unknown): void => {
    if (isTaxonomyLabel(value) && !tags.some(tag => tag.toLocaleLowerCase() === value.toLocaleLowerCase()) && tags.length < 16) tags.push(value);
  };
  for (const key of ["tags", "keywords", "topics"]) for (const label of stringList(metadata[key])) add(label.trim());
  add(metadata.agent_topic_full); add(metadata.topic_label);
  if (!metadata.agent_topic_full) add(metadata.agent_topic_short);
  const key = sourceText(metadata.agent_topic_key).toLowerCase();
  if (!tags.length && topicLabels[key]) add(topicLabels[key]);
  if (!tags.length) {
    const title = input.title.slice(0, 500);
    for (const [pattern, label] of [[/多智能体|multi[- ]agent/iu, "多智能体"], [/\bRAG\b|检索增强/iu, "RAG"], [/记忆|memory/iu, "记忆"], [/工具调用|tool[- ]use/iu, "工具调用"], [/规划|推理|reasoning|planning/iu, "规划推理"], [/评测|基准|benchmark/iu, "评测"], [/多模态|multimodal/iu, "多模态"], [/具身|embodied|\bVLA\b/iu, "具身智能"], [/安全|safety/iu, "安全"], [/视频|video/iu, "视频"]] as const) if (pattern.test(title)) add(label);
  }
  return { category, conference, year, tags };
}
