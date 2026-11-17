import type { DiffBlockLabels } from "@deepseek-ai/dsh-client-ui-primitives";

export const diffLabels: DiffBlockLabels = {
  codeLabel: "代码",
  wrapLabel: "自动换行",
  unwrapLabel: "保留原始行宽",
  copy: "复制",
  copied: "已复制",
  collapseAria: "收起差异",
  expandAria: hidden => `展开 ${hidden} 行差异`,
  collapse: "收起",
  expand: hidden => `展开 ${hidden} 行`,
};
