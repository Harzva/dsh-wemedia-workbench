import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArticleTemplatePicker } from "../../src/client/article-template-picker.tsx";

describe("article template selection", () => {
  it("filters templates by article kind and renders the selected outline", () => {
    const html = renderToStaticMarkup(React.createElement(ArticleTemplatePicker, { kind: "paper", value: "nature-review", disabled: false, onChange() {} }));
    expect(html).toContain("Nature 系列解读");
    expect(html).toContain("TPAMI 长文解读");
    expect(html).toContain("科学意义与外推限制");
    expect(html).not.toContain("系列总导航");
    expect(html).toContain('value="nature-review" selected');
  });
  it("keeps the selector disabled during a pending creation", () => {
    const html = renderToStaticMarkup(React.createElement(ArticleTemplatePicker, { kind: "article", value: "blank", disabled: true, onChange() {} }));
    expect(html).toContain('disabled=""');
    expect(html).toContain("系列总导航");
    expect(html).not.toContain("模板章节");
  });
});
