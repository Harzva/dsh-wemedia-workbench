/** Account management stays inside the workbench's existing theme and content surface. */
export const accountManagerStyles = `
.wm-workbench .wm-account-manager{width:100%;max-width:1440px;margin:auto;padding:24px;min-width:0}
.wm-account-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:22px}
.wm-account-heading h2{font-size:25px;letter-spacing:-.035em;margin:5px 0 7px}
.wm-account-heading p{margin:0;color:var(--wm-muted);max-width:690px;font-size:13px}
.wm-account-heading-actions{display:flex;gap:8px;flex-wrap:wrap;padding-top:8px}
.wm-account-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:22px}
.wm-account-summary>div{border:1px solid var(--wm-border);border-radius:12px;padding:14px 18px;background:var(--wm-panel)}
.wm-account-summary strong{font-size:25px;line-height:1.2;font-weight:650;display:block;margin-bottom:5px}
.wm-account-summary span{font-size:12px;color:var(--wm-muted)}
.wm-account-summary [data-tone=ready] strong{color:var(--wm-success)}
.wm-account-summary [data-tone=attention] strong{color:var(--wm-warn)}
.wm-account-filters{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.wm-account-filters label{display:grid;gap:5px;min-width:150px;font-size:12px;color:var(--wm-muted)}
.wm-account-filters input,.wm-account-filters select{width:100%;min-height:37px;max-width:100%;border:1px solid var(--wm-border);border-radius:9px;background:var(--wm-panel);color:var(--wm-text);padding:7px 11px}
.wm-account-filters label:first-child{width:280px}.wm-account-filters>span{padding-bottom:8px;font-size:12px;color:var(--wm-muted)}
.wm-account-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));gap:16px;align-items:stretch}
.wm-account-card{border:1px solid var(--wm-border);border-radius:15px;background:var(--wm-panel);padding:20px;min-width:0;display:flex;flex-direction:column;overflow-wrap:anywhere}
.wm-account-card-header{display:flex;align-items:center;gap:11px;margin-bottom:16px}.wm-account-card-header>div:nth-child(2){flex:1;min-width:0}
.wm-account-card-header h3{font-size:17px;margin:0}.wm-account-card-header p{font-size:11px;color:var(--wm-muted);margin:2px 0 0}
.wm-account-avatar{height:42px;width:42px;flex:none;display:grid;place-items:center;border:1px solid var(--wm-border);border-radius:13px;font-size:21px;font-weight:650;background:var(--wm-bg);color:var(--wm-text)}
.wm-account-avatar[data-channel=wechat]{color:var(--wm-success)}.wm-account-avatar[data-channel=zhihu]{color:var(--wm-accent)}.wm-account-avatar[data-channel=xiaohongshu]{color:var(--wm-error)}
.wm-account-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;white-space:nowrap;color:var(--wm-muted);border:1px solid var(--wm-border);border-radius:99px;padding:3px 8px}
.wm-account-status:before{content:'';width:5px;height:5px;flex:none;border-radius:50%;background:currentColor}
.wm-account-status[data-status=ready]{color:var(--wm-success)}.wm-account-status[data-status=login_required],.wm-account-status[data-status=expired]{color:var(--wm-warn)}.wm-account-status[data-status=error]{color:var(--wm-error)}
.wm-account-message{font-size:13px;margin:0 0 15px;min-height:42px}
.wm-account-credential{background:var(--wm-bg);border:1px solid var(--wm-border);border-radius:10px;padding:11px 13px;margin-bottom:15px}
.wm-account-credential>div{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px;color:var(--wm-muted)}
.wm-account-credential code{font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;display:block;margin:6px 0 2px;overflow-wrap:anywhere}
.wm-account-credential p{font-size:11px;color:var(--wm-muted);margin:0}
.wm-account-facts{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;font-size:12px;margin:0 0 16px}.wm-account-facts dt{color:var(--wm-muted)}.wm-account-facts dd{margin:0;text-align:right}
.wm-account-card-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:auto}.wm-account-card-actions button{flex:1;min-width:115px}
.wm-account-login-hint{font-size:11px;color:var(--wm-muted);margin:10px 0 0}
.wm-account-banner{padding:12px 14px;border:1px solid var(--wm-border);border-radius:10px;background:var(--wm-panel);font-size:13px;margin:0 0 16px;overflow-wrap:anywhere}
.wm-account-banner[data-kind=error]{color:var(--wm-error)}
.wm-account-research{margin-top:22px;padding-top:18px;border-top:1px solid var(--wm-border);display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap}
.wm-account-research p{font-size:12px;color:var(--wm-muted);margin:0;max-width:850px}.wm-account-notice{font-size:11px;color:var(--wm-muted);margin:16px 0 0}
.wm-account-login-dialog{width:min(460px,calc(100vw - 32px));max-width:100%;overflow-wrap:anywhere}
.wm-account-login-body{outline:none}.wm-account-login-body p{font-size:13px;margin:0 0 14px}.wm-account-login-body .wm-account-login-time{font-size:12px;color:var(--wm-muted)}
.wm-account-qr{display:grid;place-items:center;background:#fff;border:1px solid var(--wm-border);border-radius:12px;width:min(260px,100%);aspect-ratio:1;margin:16px auto;padding:14px}
.wm-account-qr img{display:block;width:100%;height:100%;object-fit:contain}
.wm-account-login-state{display:flex;align-items:center;gap:9px;padding:12px;background:var(--wm-panel);border:1px solid var(--wm-border);border-radius:9px;margin-bottom:15px;font-size:13px}
.wm-account-login-state[data-status=ready]{color:var(--wm-success)}.wm-account-login-state[data-status=failed],.wm-account-login-state[data-status=expired]{color:var(--wm-error)}
@media(max-width:600px){.wm-workbench .wm-account-manager{padding:16px}.wm-account-heading h2{font-size:22px}.wm-account-heading-actions{width:100%;padding:0}.wm-account-heading-actions button{flex:1}.wm-account-summary{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.wm-account-summary>div{padding:12px 14px}.wm-account-card{padding:16px}.wm-account-filters label,.wm-account-filters label:first-child{flex:1;min-width:120px;width:auto}.wm-account-card-header{gap:8px}.wm-account-avatar{width:36px;height:36px;border-radius:10px}.wm-account-status{font-size:10px;padding:3px 6px}.wm-account-card-actions button{min-width:105px}}
`;
