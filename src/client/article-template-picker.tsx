import React from "react";
import { articleTemplate, articleTemplates, type ArticleTemplateId } from "../domain/articleTemplates.ts";

export function ArticleTemplatePicker({ kind, value, disabled, onChange }: {
  kind: "paper" | "article";
  value: ArticleTemplateId;
  disabled: boolean;
  onChange: (id: ArticleTemplateId) => void;
}) {
  const template = articleTemplate(value);
  return <div className="wm-template-picker">
    <style>{`.wm-template-picker{min-width:0}.wm-template-picker label{display:flex;flex-direction:column;gap:6px}.wm-template-picker select{width:100%;max-width:100%;min-width:0;min-height:36px}.wm-template-picker ol{margin:10px 0 0;padding-left:22px;max-height:180px;overflow:auto;font-size:12px;line-height:1.8;overflow-wrap:anywhere;letter-spacing:0}.wm-template-picker li{padding-left:2px}`}</style>
    <label>文章模板<select aria-label="文章模板" value={value} disabled={disabled} onChange={event => onChange(event.target.value as ArticleTemplateId)}>
      {articleTemplates().filter(item => item.kind === "any" || item.kind === kind).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select></label>
    {template.sections.length > 0 && <ol aria-label="模板章节">{template.sections.map(section => <li key={section.title}>{section.title}</li>)}</ol>}
  </div>;
}
