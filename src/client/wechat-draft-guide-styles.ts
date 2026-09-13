export const wechatDraftGuideStyles = `
.wm-wechat-guide{display:flex;flex-direction:column;gap:20px;min-width:0;max-width:980px;color:var(--wm-text)}
.wm-wechat-guide p{margin:0;line-height:1.7}
.wm-wechat-guide-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.wm-wechat-guide-heading h3{margin:5px 0 8px;font-size:20px}
.wm-wechat-guide-heading p{font-size:13px;color:var(--wm-muted)}
.wm-wechat-guide-heading>.wm-pill{margin-top:5px}
.wm-wechat-guide-steps{list-style:none;margin:0;padding:0;border:1px solid var(--wm-border);border-radius:14px;background:var(--wm-panel);overflow:hidden}
.wm-wechat-guide-step{display:grid;grid-template-columns:30px minmax(0,1fr);gap:16px;padding:24px}
.wm-wechat-guide-step+.wm-wechat-guide-step{border-top:1px solid var(--wm-border)}
.wm-wechat-guide-number{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--wm-border);border-radius:50%;font-size:13px;font-weight:650;background:var(--wm-bg)}
.wm-wechat-guide-step-body{display:flex;flex-direction:column;gap:14px;min-width:0}
.wm-wechat-guide-step-body>h4,.wm-wechat-guide-step-heading>h4{font-size:16px;line-height:30px}
.wm-wechat-guide-step-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;min-width:0}
.wm-wechat-guide-reviews{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));list-style:none;gap:10px;margin:0;padding:0}
.wm-wechat-guide-reviews li{display:flex;flex-direction:column;gap:5px;border:1px solid var(--wm-border);border-radius:9px;padding:12px;background:var(--wm-bg);font-size:12px;min-width:0}
.wm-wechat-guide-reviews li span{color:var(--wm-muted);line-height:1.6}
.wm-wechat-guide-check,.wm-wechat-guide-result{display:flex;flex-direction:column;gap:12px;background:var(--wm-bg);border:1px solid var(--wm-border);padding:16px;border-radius:10px;min-width:0;font-size:13px}
.wm-wechat-guide-check[data-status=block]{border-color:var(--wm-warn)}
.wm-wechat-guide-check ul{display:flex;flex-direction:column;gap:10px;margin:8px 0 0;padding-left:20px;line-height:1.7}
.wm-wechat-guide-check code,.wm-wechat-guide dd{overflow-wrap:anywhere;word-break:break-word}
.wm-wechat-guide-mode{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:0;border:0;margin:0;min-width:0}
.wm-wechat-guide-mode legend{margin-bottom:10px;font-size:13px;color:var(--wm-muted)}
.wm-workbench .wm-wechat-guide-mode label{display:flex;flex-direction:row;align-items:flex-start;gap:10px;padding:14px;border:1px solid var(--wm-border);border-radius:10px;cursor:pointer;color:var(--wm-text);background:var(--wm-bg)}
.wm-workbench .wm-wechat-guide-mode label:has(input:checked){border-color:var(--wm-accent)}
.wm-workbench .wm-wechat-guide-mode input[type=radio]{appearance:auto;flex-shrink:0;width:16px;height:16px;min-height:0;padding:0;margin:2px 0 0;accent-color:var(--wm-accent)}
.wm-wechat-guide-mode label span{display:flex;flex-direction:column;gap:6px;min-width:0}
.wm-wechat-guide-mode small{font-size:12px;font-weight:400;color:var(--wm-muted);line-height:1.6}
.wm-wechat-guide-mode:disabled label{cursor:default;opacity:.6}
.wm-wechat-guide-target{display:flex;flex-direction:column;align-items:flex-start;gap:12px;min-width:0}
.wm-wechat-guide-target>label{width:100%;max-width:620px}
.wm-wechat-guide-target select{max-width:100%;text-overflow:ellipsis}
.wm-wechat-guide-verified{color:var(--wm-success)}
.wm-wechat-guide-submit{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding-top:4px}
.wm-wechat-guide-primary{min-height:40px;max-width:100%;white-space:normal;text-align:center}
.wm-wechat-guide-notice{padding:12px 14px;border:1px solid var(--wm-border);border-radius:9px;font-size:13px;background:var(--wm-bg)}
.wm-wechat-guide details{min-width:0;line-height:1.7}
.wm-wechat-guide summary{cursor:pointer;color:var(--wm-muted);font-size:12px;overflow-wrap:anywhere}
.wm-wechat-guide details[open]>summary{margin-bottom:10px}
.wm-wechat-guide-advanced{border-top:1px solid var(--wm-border);padding-top:16px;margin-top:2px}
.wm-wechat-guide-advanced-body{display:flex;flex-direction:column;gap:12px}
.wm-wechat-guide dl{margin:0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:7px 12px}
.wm-wechat-guide dt{color:var(--wm-muted)}
.wm-wechat-guide dd{margin:0;font-family:monospace;min-width:0}
@media(max-width:620px){
  .wm-wechat-guide{gap:16px}
  .wm-wechat-guide-heading h3{font-size:18px}
  .wm-wechat-guide-step{grid-template-columns:26px minmax(0,1fr);gap:10px;padding:18px 12px}
  .wm-wechat-guide-number{width:26px;height:26px}
  .wm-wechat-guide-step-body{gap:12px}
  .wm-wechat-guide-mode,.wm-wechat-guide-reviews{grid-template-columns:minmax(0,1fr)}
  .wm-wechat-guide-check,.wm-wechat-guide-result{padding:12px}
  .wm-wechat-guide-primary{width:100%}
  .wm-wechat-guide-submit{align-items:stretch}
  .wm-wechat-guide dl{grid-template-columns:minmax(0,1fr);gap:4px}
  .wm-wechat-guide dd+dt{margin-top:6px}
}
`;
