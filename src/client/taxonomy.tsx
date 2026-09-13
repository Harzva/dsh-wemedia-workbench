import React from "react";
import type { ReactNode } from "react";
import type { ArticleCategory, ArticleTaxonomy } from "../domain/articleTaxonomy.ts";

export const articleCategoryLabel = (category: ArticleCategory): string => ({ conference: "会议", arxiv: "arXiv", other: "其他 / 未分类" })[category];

export const taxonomyStyles = `
.wm-taxonomy{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:9px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}
.wm-taxonomy-chip{display:inline-block;max-width:100%;padding:1px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;overflow-wrap:anywhere}
.wm-taxonomy-source{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.wm-taxonomy-tag{border-color:transparent;background:var(--dsw-alias-bg-layer-2)}
.wm-taxonomy[data-compact]{margin-top:0;font-size:10px;gap:4px;max-height:42px;overflow:hidden}
.wm-taxonomy[data-compact] .wm-taxonomy-chip{padding:0 4px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wm-taxonomy-empty{font-size:10px;color:var(--dsw-alias-label-secondary)}
`;

/** Host-supplied taxonomy is presentation data; the Client never infers topics from article text. */
export function ArticleTaxonomyChips({ taxonomy, compact = false }: { taxonomy?: ArticleTaxonomy | undefined; compact?: boolean }): ReactNode {
  const tags = taxonomy?.tags ?? [];
  const source = taxonomy ? articleCategoryLabel(taxonomy.category) : "未分类";
  const event = [taxonomy?.conference, taxonomy?.year].filter(value => value !== null && value !== undefined && value !== "").join(" ");
  return <span className="wm-taxonomy" data-compact={compact || undefined} aria-label="文章分类与标签"><span className="wm-taxonomy-chip wm-taxonomy-source">{source}</span>{event && <span className="wm-taxonomy-chip">{event}</span>}{(compact ? tags.slice(0, 2) : tags).map(tag => <span className="wm-taxonomy-chip wm-taxonomy-tag" key={tag} title={tag}>{tag}</span>)}{compact && tags.length > 2 && <span className="wm-taxonomy-empty" aria-label={`另外 ${tags.length - 2} 个标签`}>+{tags.length - 2}</span>}{!compact && !tags.length && <span className="wm-taxonomy-empty">暂无主题标签</span>}</span>;
}
