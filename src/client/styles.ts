/** Scoped presentation only. Shared controls and diff/modal chrome come from DSH. */
export const workbenchStyles = `
.wm-article-next{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:16px 0 10px}.wm-article-next>div:first-child{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:12px;color:var(--wm-muted)}.wm-article-records{font-size:11px;color:var(--wm-muted);margin:8px 0 0}.wm-article-records>summary{cursor:pointer}.wm-other-channels{border:1px solid var(--wm-border);border-radius:12px;padding:16px}.wm-other-channels>summary{font-size:12px;cursor:pointer;color:var(--wm-muted)}


.wm-workbench{
  --wm-bg:var(--dsw-alias-bg-base);--wm-panel:var(--dsw-alias-bg-layer-2);
  --wm-border:var(--dsw-alias-border-l2);--wm-text:var(--dsw-alias-label-primary);
  --wm-muted:var(--dsw-alias-label-secondary);--wm-accent:var(--dsw-alias-brand-primary);
  --wm-hover:var(--dsw-alias-interactive-bg-hover);--wm-error:var(--dsw-alias-state-error-primary);
  --wm-success:var(--dsw-alias-state-success-primary);--wm-warn:var(--dsw-alias-state-warn-primary);
  color:var(--wm-text);font:14px/1.6 system-ui,sans-serif;box-sizing:border-box;
}
.wm-workbench *{box-sizing:border-box}
.wm-workbench h1,.wm-workbench h2,.wm-workbench h3,.wm-workbench h4{line-height:1.4;color:var(--wm-text)}
.wm-workbench h3,.wm-workbench h4{margin:0}
.wm-workbench button,.wm-workbench input,.wm-workbench textarea,.wm-workbench select{font:inherit}
.wm-workbench button:disabled{cursor:not-allowed}
.wm-workbench :focus-visible{outline:2px solid var(--wm-accent);outline-offset:3px}
.wm-workbench a{color:var(--wm-accent);text-underline-offset:3px;overflow-wrap:anywhere}
.wm-workbench .wm-danger{color:var(--wm-error)}
.wm-muted{color:var(--wm-muted)}
.wm-small{font-size:12px;line-height:1.6}
.wm-code{font:12px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
.wm-error{color:var(--wm-error)}
.wm-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.wm-between{justify-content:space-between}
.wm-stack{display:flex;flex-direction:column;gap:18px}
.wm-section-title{font-size:16px;margin:0 0 10px}
.wm-eyebrow{font-size:11px;color:var(--wm-muted);letter-spacing:.07em}
.wm-workbench .wm-native-button{flex-shrink:0}
.wm-workbench .wm-icon-button{border:0;background:transparent;color:var(--wm-muted);cursor:pointer;border-radius:9px;display:inline-grid;place-items:center;width:34px;height:34px;flex:none}
.wm-workbench .wm-icon-button:hover{background:var(--wm-hover);color:var(--wm-text)}
.wm-workbench .wm-icon-button:disabled{opacity:.4}
.wm-launcher.wm-workbench{width:100%;display:flex;align-items:center;gap:8px;justify-content:center;background:transparent;color:var(--dsw-alias-label-primary);border:0;cursor:pointer;min-height:38px;border-radius:8px;padding:8px}
.wm-launcher:hover{background:var(--dsw-alias-bg-layer-2)}

.wm-overlay{pointer-events:none;position:absolute;inset:0;display:flex;justify-content:flex-end;padding:10px;z-index:2}
.wm-panel{pointer-events:auto;display:flex;flex-direction:column;width:min(1440px,100%);height:100%;background:var(--wm-bg);border:1px solid var(--wm-border);border-radius:16px;box-shadow:0 16px 60px #0003;overflow:hidden}
.wm-header{display:flex;gap:12px;align-items:center;padding:15px 22px}
.wm-header h1{font-size:18px;letter-spacing:-.025em;margin:0}
.wm-header p{margin:2px 0 0;color:var(--wm-muted);font-size:12px}
.wm-header-title{flex:1;min-width:0}
.wm-mark{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;background:var(--wm-panel);border:1px solid var(--wm-border);color:var(--wm-accent);font-weight:750;font-size:18px}
.wm-tag{font-size:10px;letter-spacing:.05em;border:1px solid var(--wm-border);border-radius:5px;padding:1px 5px;color:var(--wm-muted)}
.wm-connection{display:inline-flex;align-items:center;gap:6px;color:var(--wm-muted);font-size:12px;margin-right:5px}
.wm-connection i{width:6px;height:6px;border-radius:50%;background:var(--wm-muted)}
.wm-connection[data-connected=true] i{background:var(--wm-success)}
.wm-nav-row{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--wm-border);padding:0 22px}
.wm-tabs{display:flex;gap:24px;overflow:auto}
.wm-tabs button{display:flex;align-items:center;gap:7px;white-space:nowrap;cursor:pointer;border:0;border-bottom:2px solid transparent;background:transparent;padding:11px 2px 12px;color:var(--wm-muted)}
.wm-tabs button[aria-selected=true]{color:var(--wm-text);border-bottom-color:var(--wm-accent);font-weight:650}
.wm-count{font-size:10px;border-radius:7px;padding:0 5px;background:var(--wm-panel)}
.wm-nav-hint{font-size:11px;color:var(--wm-muted);white-space:nowrap}
.wm-body{flex:1;min-height:0;overflow:auto;background:var(--wm-bg);outline:none}
.wm-body-articles{overflow:hidden}
.wm-notice{margin:10px 16px;padding:10px 12px;border:1px solid var(--wm-border);border-radius:9px;display:flex;gap:10px;align-items:flex-start;font-size:13px;background:var(--wm-panel);overflow-wrap:anywhere;max-height:145px;overflow:auto;flex-shrink:0}
.wm-notice-message{flex:1}
.wm-notice p{margin:0}
.wm-notice[data-kind=error]{border-color:var(--wm-error);color:var(--wm-error)}
.wm-notice-code{font-size:11px}

.wm-article-workspace{display:grid;grid-template-columns:224px minmax(0,1fr);height:100%;min-height:0}
.wm-library{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--wm-border);background:var(--wm-panel)}
.wm-library-top{padding:20px 16px 14px;display:flex;flex-direction:column;gap:14px}
.wm-library h2{font-size:14px;margin:0}
.wm-search{display:flex;align-items:center;gap:2px;border:1px solid var(--wm-border);border-radius:9px;background:var(--wm-bg)}
.wm-workbench .wm-search input{padding:8px 9px;font-size:12px;border:0;background:transparent;outline-offset:0}
.wm-search input{flex:1;min-width:0}
.wm-workbench .wm-search .wm-icon-button{width:44px;font-size:11px;white-space:nowrap}
.wm-new-article{width:100%}
.wm-list{flex:1;min-height:0;overflow:auto;padding:0 10px 12px;display:flex;flex-direction:column;gap:6px}
.wm-article-item{display:block;width:100%;text-align:left;padding:13px 11px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--wm-text);cursor:pointer;flex-shrink:0}
.wm-article-item:hover{background:var(--wm-hover)}
.wm-article-item[aria-pressed=true]{background:var(--wm-bg);border-color:var(--wm-border);box-shadow:inset 3px 0 var(--wm-accent)}
.wm-list-title{display:block;font-weight:600;font-size:13px;line-height:1.6;margin-bottom:8px;overflow-wrap:anywhere}
.wm-list-source{display:block;color:var(--wm-muted);font-size:11px;margin-top:8px;overflow-wrap:anywhere}
.wm-library-bottom{padding:14px 16px;border-top:1px solid var(--wm-border)}
.wm-library-bottom p{margin:12px 0 0;line-height:1.6}
.wm-pagination{display:flex;justify-content:space-between;align-items:center;gap:4px;font-size:12px;color:var(--wm-muted)}
.wm-detail{min-width:0;min-height:0;overflow:hidden}
.wm-mobile-library-bar{display:none}
.wm-article-detail{height:100%;display:flex;flex-direction:column;min-height:0}
.wm-article-header{padding:17px 24px 14px;flex-shrink:0}
.wm-article-header h2{font-size:21px;font-weight:650;letter-spacing:-.025em;margin:5px 0 10px;overflow-wrap:anywhere}
.wm-context-line{display:flex;gap:12px;align-items:center;flex-wrap:wrap;color:var(--wm-muted);font-size:11px}
.wm-context-line .wm-pill{font-size:10px}
.wm-article-tabs{display:flex;gap:20px;padding:0 24px;border-top:1px solid var(--wm-border);border-bottom:1px solid var(--wm-border);overflow:auto;flex-shrink:0}
.wm-article-tabs button{cursor:pointer;border:0;border-bottom:2px solid transparent;background:transparent;padding:12px 0;color:var(--wm-muted);font-size:12px;white-space:nowrap}
.wm-article-tabs button[aria-current=page]{color:var(--wm-text);border-color:var(--wm-accent);font-weight:650}
.wm-article-content{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.wm-editor-toolbar{padding:16px 24px 0;display:flex;gap:12px;justify-content:space-between;align-items:center}
.wm-segmented{display:inline-flex;gap:2px;border:1px solid var(--wm-border);border-radius:8px;padding:3px;flex-shrink:0}
.wm-segmented button{border:0;background:transparent;padding:4px 8px;color:var(--wm-muted);font-size:11px;cursor:pointer;border-radius:5px}
.wm-segmented button[aria-pressed=true]{background:var(--wm-panel);color:var(--wm-text);font-weight:650}
.wm-edit-layout{display:grid;grid-template-columns:minmax(0,1fr) 392px;gap:24px;align-items:start;padding:18px 24px 24px}
.wm-editor-column{min-width:0;gap:15px}
.wm-preview-column{position:sticky;top:18px;min-width:0}
.wm-edit-layout[data-mode=edit]{grid-template-columns:1fr}
.wm-edit-layout[data-mode=edit] .wm-preview-column{display:none}
.wm-edit-layout[data-mode=preview]{grid-template-columns:minmax(0,1fr)}
.wm-edit-layout[data-mode=preview] .wm-editor-column{display:none}
.wm-edit-layout[data-mode=preview] .wm-preview-column{width:min(480px,100%);justify-self:center}
.wm-workbench label{display:flex;flex-direction:column;gap:6px;font-size:12px;font-weight:500;color:var(--wm-muted)}
.wm-workbench input,.wm-workbench select,.wm-workbench textarea{width:100%;padding:10px 11px;background:var(--wm-bg);border:1px solid var(--wm-border);border-radius:8px;min-width:0;color:var(--wm-text)}
.wm-workbench textarea{resize:vertical;line-height:1.65}
.wm-workbench .wm-code-editor{font:13px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;min-height:320px;background:var(--wm-panel);tab-size:2}
.wm-body-label>span>span{font-size:10px;font-weight:400}
.wm-preview-card{border:1px solid var(--wm-border);border-radius:12px;padding:14px;background:var(--wm-panel);min-width:0}
.wm-preview-heading{display:flex;gap:8px;align-items:center;justify-content:space-between;font-size:12px;font-weight:600}
.wm-preview-description{font-size:11px;color:var(--wm-muted);line-height:1.65;margin:8px 0 12px}
.wm-mobile{width:100%;max-width:390px;overflow:hidden;background:white;border-radius:5px;margin:0 auto}
.wm-mobile iframe{display:block;width:390px;min-width:390px;height:620px;border:0;background:white;transform-origin:top left}
.wm-preview-footer{display:flex;justify-content:space-between;font-size:10px;color:var(--wm-muted);margin-top:10px}
.wm-savebar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 24px;border-top:1px solid var(--wm-border);background:var(--wm-bg);box-shadow:0 -3px 15px #00000005;flex-shrink:0}
.wm-save-status{display:flex;gap:10px;align-items:center;min-width:0}
.wm-save-status strong{display:block;font-size:12px;font-weight:600}
.wm-save-status span:not(.wm-state-dot){display:block;font-size:10px;color:var(--wm-muted);margin-top:2px}
.wm-state-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--wm-success);flex:none}
.wm-state-dot[data-dirty=true],.wm-state-dot[data-status=waiting_user],.wm-state-dot[data-status=reconcile_required]{background:var(--wm-warn)}
.wm-state-dot[data-status=running],.wm-state-dot[data-status=queued]{background:var(--wm-accent)}
.wm-state-dot[data-status=failed],.wm-state-dot[data-status=timed_out]{background:var(--wm-error)}
.wm-section-content{padding:24px}
.wm-section-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;flex-wrap:wrap}
.wm-section-heading h3{font-size:19px;margin:6px 0}
.wm-section-heading p{margin:6px 0}
.wm-pill{display:inline-flex;align-items:center;padding:2px 7px;border:1px solid var(--wm-border);border-radius:6px;font-size:11px;line-height:1.5;white-space:normal}
.wm-pill[data-status=failed],.wm-pill[data-status=block],.wm-pill[data-status=timed_out],.wm-pill[data-status=unavailable]{color:var(--wm-error)}
.wm-pill[data-status=available],.wm-pill[data-status=succeeded],.wm-pill[data-status=pass]{color:var(--wm-success)}
.wm-pill[data-status=warn],.wm-pill[data-status=reconcile_required],.wm-pill[data-status=waiting_user]{color:var(--wm-warn)}

.wm-page-content{max-width:1120px;margin:0 auto;padding:32px}
.wm-page-heading h2{font-size:26px;letter-spacing:-.04em;margin:6px 0 10px}
.wm-page-heading p{margin:0;color:var(--wm-muted);font-size:13px;line-height:1.8;max-width:660px}
.wm-card{border:1px solid var(--wm-border);border-radius:12px;padding:20px;background:var(--wm-bg);min-width:0}
.wm-card h3{font-size:15px}
.wm-card p{margin:6px 0}
.wm-inline-note{border:1px solid var(--wm-border);border-radius:9px;padding:13px 15px;background:var(--wm-panel);font-size:12px;color:var(--wm-muted)}
.wm-welcome{height:100%;min-height:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px;text-align:center}
.wm-welcome-mark{display:grid;place-items:center;width:56px;height:56px;background:var(--wm-panel);border:1px solid var(--wm-border);border-radius:17px;font-weight:700;font-size:26px;color:var(--wm-accent)}
.wm-welcome h2{font-size:25px;letter-spacing:-.04em;margin:22px 0 8px}
.wm-welcome p{font-size:13px;color:var(--wm-muted);line-height:1.9;margin:0 0 22px}
.wm-welcome-steps{display:flex;gap:20px;font-size:11px;color:var(--wm-muted);margin-bottom:24px}
.wm-empty{padding:30px 18px;text-align:center;border:1px dashed var(--wm-border);border-radius:10px;color:var(--wm-muted);font-size:12px}
.wm-empty h3{font-size:15px;margin-bottom:8px}
.wm-empty p{margin:8px 0 16px}
.wm-step-number{display:grid;place-items:center;width:32px;height:32px;flex:none;border-radius:9px;font-size:12px;font-weight:650;background:var(--wm-panel);color:var(--wm-muted);border:1px solid var(--wm-border)}
.wm-delivery-card{display:flex;gap:18px}
.wm-delivery-card>div{flex:1;min-width:0}
.wm-delivery-card p{font-size:13px;margin:7px 0 14px}
.wm-article-context{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 18px;border:1px solid var(--wm-border);border-radius:10px;background:var(--wm-panel)}
.wm-article-context strong{font-size:13px}
.wm-agent-grid,.wm-setup-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.wm-agent-card{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:24px}
.wm-agent-card h3{margin-top:4px;font-size:17px}
.wm-agent-card p{font-size:13px;line-height:1.8}
.wm-agent-card p:nth-last-of-type(1){margin-top:auto;font-size:11px}
.wm-setup-grid h3{margin:15px 0 8px}
.wm-filter-row{display:flex;gap:8px;overflow:auto}
.wm-filter-row button{display:flex;gap:8px;align-items:center;border:1px solid var(--wm-border);border-radius:8px;padding:7px 12px;background:transparent;cursor:pointer;color:var(--wm-muted);font-size:12px;white-space:nowrap}
.wm-filter-row button[aria-pressed=true]{background:var(--wm-panel);border-color:var(--wm-accent);color:var(--wm-text)}
.wm-filter-row button span{font-size:10px}
.wm-job-list{display:flex;flex-direction:column;gap:12px}
.wm-job h3{margin:0;font-size:14px}
.wm-job>p{font-size:13px;margin:13px 0}
.wm-job progress{display:block;width:100%;height:5px;margin:14px 0;accent-color:var(--wm-accent)}
.wm-job-details{font-size:11px;color:var(--wm-muted);border-top:1px solid var(--wm-border);margin-top:12px;padding-top:10px}
.wm-root-list{list-style:none;padding:0!important}
.wm-root-list li{display:flex;gap:12px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--wm-border);padding:12px 0}
.wm-root-list li:last-child{border-bottom:0}
.wm-capability-list{margin-top:15px}
.wm-capability-list>details{border-top:1px solid var(--wm-border);padding:12px 0}
.wm-capability-list>details>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px}
.wm-workbench ul{padding-left:20px;margin:8px 0}
.wm-workbench li{margin:5px 0}
.wm-workbench details>summary{cursor:pointer}
.wm-workbench details>summary:hover{color:var(--wm-accent)}
.wm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(210px,100%),1fr));gap:14px}

.wm-facts-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin:0}
.wm-facts-grid>div{min-width:0}
.wm-facts-grid dt,.wm-evidence-meta dt{font-size:11px;color:var(--wm-muted)}
.wm-facts-grid dd,.wm-evidence-meta dd{margin:4px 0 0;font-size:13px;overflow-wrap:anywhere}
.wm-workbench .wm-material-list,.wm-workbench .wm-review-list{list-style:none;padding:0;margin:0}
.wm-material-item,.wm-review-item{border:1px solid var(--wm-border);border-radius:10px;padding:16px;gap:8px;background:var(--wm-panel)}
.wm-material-item strong{font-size:13px;overflow-wrap:anywhere}
.wm-material-item p,.wm-review-item p{margin:0}
.wm-review-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.wm-review-summary>div{border:1px solid var(--wm-border);border-radius:10px;padding:14px;background:var(--wm-panel)}
.wm-review-summary h4{font-size:13px;margin:0 0 10px}
.wm-review-summary [data-review-state=current]{border-color:var(--wm-accent)}
.wm-ai-diagnostic{border:1px solid var(--wm-border);border-radius:10px;padding:15px;background:var(--wm-panel)}
.wm-ai-diagnostic h4{font-size:13px;margin:0 0 4px}
.wm-ai-diagnostic [data-status=pass]{color:var(--wm-success)}
.wm-ai-diagnostic [data-status=warn]{color:var(--wm-warn)}
.wm-ai-diagnostic [data-status=block]{color:var(--wm-error)}
.wm-workflow-imports{border-top:1px solid var(--wm-border);padding-top:18px}
.wm-workflow-imports h4{font-size:13px;margin:0 0 5px}
.wm-import-preview{background:var(--wm-panel)}
.wm-import-preview h3{margin:0 0 4px}
.wm-import-dialog{width:min(820px,100%);max-height:calc(100vh - 48px)}
.wm-import-footer{width:100%;display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.wm-import-footer-reason{flex:0 0 100%;min-width:0;overflow-wrap:anywhere;text-align:left}
.wm-import-footer-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;width:100%;min-width:0}
.wm-import-footer-actions .wm-native-button{flex:0 0 auto}
.wm-evidence-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:8px 0}
.wm-evidence-meta>div:last-child{grid-column:1/-1}
.wm-gate-list li{margin:0!important;padding:12px 0;border-bottom:1px solid var(--wm-border);font-size:13px}
.wm-gate-list li:last-child{border:0}
.wm-gate-list details{margin-top:5px;color:var(--wm-muted)}
.wm-workbench .wm-section-content button:not(.wm-native-button){cursor:pointer;padding:7px 12px;border:1px solid var(--wm-border);border-radius:9px;background:var(--wm-panel);color:var(--wm-text)}
.wm-workbench .wm-section-content button:disabled{opacity:.45}

.wm-workbench.wm-create-dialog{width:min(620px,100%);max-height:calc(100vh - 48px);overflow:auto}
.wm-workbench.wm-action-dialog{width:min(880px,100%);max-height:calc(100vh - 48px)}
.wm-workbench.wm-confirm-dialog{width:min(460px,100%)}
.wm-dialog-scroll{overflow:auto;min-height:0}
.wm-native-diff{max-height:380px;overflow:auto}
.wm-native-diff [data-row]{overflow-wrap:anywhere}
.wm-intent-summary{border:1px solid var(--wm-border);border-radius:10px;padding:15px;background:var(--wm-panel);font-size:13px}
.wm-intent-summary ul{padding-left:17px}
.wm-settings-card{padding:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}
.wm-settings-card h3{margin:0 0 6px;font-size:14px}
.wm-settings-card>div>p{margin:0 0 12px;color:var(--dsw-alias-label-secondary);font-size:13px}
.wm-settings-card .wm-page-content{padding:16px 0 0}
.wm-settings-card .wm-setup-grid{grid-template-columns:1fr}
.wm-settings-card .wm-page-heading h2{font-size:20px}

@media(max-width:1160px){
  .wm-article-workspace{grid-template-columns:210px minmax(0,1fr)}
  .wm-edit-layout{grid-template-columns:minmax(0,1fr)}
  .wm-edit-layout[data-mode=split] .wm-preview-column{display:none}
  .wm-split-option{display:none}
  .wm-preview-column{position:static}
  .wm-edit-layout[data-mode=preview] .wm-preview-column{width:min(480px,100%)}
  .wm-editor-toolbar>.wm-small{max-width:240px}
  .wm-agent-grid{gap:12px}
}
@media(max-width:760px){
  .wm-overlay{padding:0}
  .wm-panel{border-radius:0;border:0}
  .wm-header{padding:12px 14px;gap:8px}
  .wm-header h1{font-size:16px}
  .wm-header p{font-size:11px;max-width:245px}
  .wm-tag,.wm-connection,.wm-nav-hint,.wm-mark,.wm-refresh-label{display:none}
  .wm-nav-row{padding:0 14px}
  .wm-tabs{gap:20px}
  .wm-tabs button{font-size:12px;padding:10px 0}
  .wm-article-workspace{display:flex;flex-direction:column}
  .wm-mobile-library-bar{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--wm-border);background:var(--wm-panel);flex-shrink:0}
  .wm-library{display:none;max-height:55%;flex:0 1 55%;border-right:0;border-bottom:1px solid var(--wm-border)}
  .wm-article-workspace[data-library-open=true] .wm-library{display:flex}
  .wm-library-top{padding:12px;gap:10px}
  .wm-library-top .wm-new-article{display:none}
  .wm-library-bottom{padding:8px 12px}
  .wm-library-bottom p{display:none}
  .wm-detail{flex:1;min-height:0}
  .wm-article-header{padding:12px 14px}
  .wm-article-header h2{font-size:18px;margin:5px 0 8px}
  .wm-context-line{gap:8px;font-size:10px}
  .wm-context-line>span:last-child{display:none}
  .wm-article-tabs{padding:0 14px;gap:18px}
  .wm-article-tabs button{font-size:11px;padding:10px 0}
  .wm-editor-toolbar{padding:12px 14px 0;justify-content:flex-end}
  .wm-editor-toolbar>.wm-small{display:none}
  .wm-edit-layout{padding:14px;gap:14px}
  .wm-workbench .wm-code-editor{min-height:330px;font-size:13px}
  .wm-preview-card{padding:10px}
  .wm-savebar{padding:10px 12px;gap:8px;flex-wrap:wrap}
  .wm-save-status{gap:7px}
  .wm-save-status strong{font-size:11px}
  .wm-save-status span:not(.wm-state-dot){display:none}
  .wm-savebar>.wm-row{gap:2px;margin-left:auto}
  .wm-savebar .wm-native-button{font-size:12px;padding:0 10px}
  .wm-section-content{padding:14px}
  .wm-page-content{padding:22px 16px}
  .wm-page-heading h2{font-size:23px}
  .wm-agent-grid,.wm-setup-grid{grid-template-columns:1fr}
  .wm-agent-card{gap:9px;padding:18px}
  .wm-card{padding:16px}
  .wm-section-heading h3{font-size:17px}
  .wm-delivery-card{gap:12px}
  .wm-facts-grid,.wm-evidence-meta{grid-template-columns:1fr}
  .wm-review-summary{gap:8px}
  .wm-review-summary>div{padding:11px}
  .wm-welcome{padding:20px 14px;min-height:240px}
  .wm-welcome h2{font-size:22px;margin-top:15px}
  .wm-welcome-steps{gap:12px;font-size:10px}
  .wm-workbench.wm-create-dialog,.wm-workbench.wm-action-dialog{max-height:calc(100dvh - 24px)}
  .wm-workbench.wm-import-dialog{max-height:calc(100dvh - 24px)}
  .wm-action-dialog .wm-native-button{font-size:12px;padding:0 10px}
  .wm-notice{margin:8px 12px;font-size:12px;max-height:100px}
}
.wm-evidence-dialog{width:min(900px,calc(100vw - 24px));max-height:calc(100dvh - 24px)}
.wm-evidence-dialog .wm-stack{min-width:0}
.wm-workbench .wm-report-body{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:inherit;line-height:1.7;padding:16px;background:var(--wm-bg);border:1px solid var(--wm-border);border-radius:10px;max-height:65vh;overflow:auto}
.wm-workbench .wm-screenshot{margin:0;max-width:100%}
.wm-workbench .wm-screenshot img{display:block;max-width:100%;height:auto;margin:auto;border:1px solid var(--wm-border)}
.wm-workbench .wm-screenshot figcaption{text-align:center;font-size:12px;color:var(--wm-muted);margin-top:8px}
.wm-workbench .wm-paragraph-list,.wm-workbench .wm-source-list{padding-left:24px;overflow-wrap:anywhere}
.wm-workbench .wm-paragraph-list li,.wm-workbench .wm-source-list li{padding:8px 0}
@media(prefers-reduced-motion:reduce){.wm-workbench *{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
`;
