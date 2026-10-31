window.__ModuleLoader__.load({id:"dsh-auto-dev",factory:(require)=>{var module={exports:{}};var exports=module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.js
var client_exports = {};
__export(client_exports, {
  Board: () => Board,
  StreamCard: () => StreamCard,
  apply: () => apply,
  css: () => css,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = __toESM(require("react"), 1);

// src/mode.mjs
var effectiveMode = (mode) => mode === "build" ? "do" : mode ?? "do";
var modeLabel = (mode) => effectiveMode(mode) === "look" ? "\u67E5\u770B\uFF08\u53EA\u8BFB\u610F\u56FE\uFF09" : mode === "build" ? "\u4EA4\u4ED8\uFF08\u5386\u53F2 build\uFF09" : "\u4EA4\u4ED8";

// src/client.js
var h = import_react.default.createElement;
var laneWord = (state) => modeLabel(state.mode);
var outcomeWord = (outcome) => ({ complete: "\u5DF2\u8FBE\u6210", partial: "\u90E8\u5206\u5B8C\u6210", blocked: "\u53D7\u963B", failed: "\u672A\u8FBE\u6210" })[outcome] ?? "\u8FDB\u884C\u4E2D";
var EMPTY_NEXT = /* @__PURE__ */ new Set(["", "none", "\u65E0", "n/a", "na", "-"]);
var cleanNext = (value) => typeof value === "string" && !EMPTY_NEXT.has(value.trim().toLowerCase()) ? value.trim() : "";
var settledState = (state) => {
  if (state.taskState === "cancelled" || state.taskState === "paused" || state.taskState === "review_ready") return state.taskState;
  const units = state.units ?? [];
  const leaves = units.filter((unit) => !units.some((candidate) => candidate.parent === unit.id));
  return leaves.length > 0 && leaves.every((unit) => unit.state === "done") ? "closed" : state.taskState;
};
var pillOf = (state) => {
  const settled = settledState(state);
  if (settled === "cancelled") return ["\u5DF2\u53D6\u6D88", "danger"];
  if (settled === "paused") return ["\u5DF2\u6682\u505C", "warning"];
  if (settled === "review_ready") return ["\u7B49\u4F60\u7528\u8FC7", "warning"];
  if (settled === "closed") return ["\u5DF2\u6536", "muted"];
  return ["\u8FDB\u884C\u4E2D", "accent"];
};
var live = (state) => ["active", "paused"].includes(settledState(state));
var clamp = (value, max) => value.length > max ? `${value.slice(0, max - 1)}\u2026` : value;
var headline = (state) => settledState(state) === "closed" && state.last ? `\u4E0A\u4E00\u6B21\u4EA4\u4ED8\uFF1A${outcomeWord(state.last.outcome)}${state.last.summary ? ` \xB7 ${clamp(state.last.summary, 52)}` : ""}` : settledState(state) === "review_ready" ? clamp(state.goal || state.request || cleanNext(state.next) || "", 72) : clamp(cleanNext(state.next) || state.goal || state.request || "", 72);
var unitMark = (state) => state === "done" ? "\u2713" : state === "active" ? "\u25B8" : state === "blocked" ? "!" : "\u25CB";
var unitWord = (state) => ({ done: "\u5DF2\u5B8C\u6210", active: "\u8FDB\u884C\u4E2D", blocked: "\u53D7\u963B" })[state] ?? "\u672A\u5F00\u59CB";
function clockOf(at) {
  if (typeof at !== "string" || at === "") return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
}
function elapsedWord(since, now = Date.now()) {
  const start = typeof since === "number" ? since : typeof since === "string" ? new Date(since).getTime() : NaN;
  if (Number.isNaN(start)) return "";
  const minutes = Math.max(0, Math.round((now - start) / 6e4));
  return minutes < 1 ? "\u521A\u5F00\u59CB" : minutes < 60 ? `${minutes} \u5206` : `${Math.floor(minutes / 60)} \u65F6 ${minutes % 60} \u5206`;
}
var warningLines = (state) => Array.isArray(state.reminders) ? state.reminders : Array.isArray(state.warningLines) ? state.warningLines : [];
var warningsLabel = (n) => `${n} \u6761\u63D0\u9192`;
var css = `
.ad3{--ad3-bg:var(--dsw-alias-bg-base,var(--background-primary,#f7f8fa));--ad3-surface:var(--dsw-specific-tip,var(--background-secondary,#fff));--ad3-border:var(--dsw-alias-border-l1,var(--border-color,#d9dde3));--ad3-border-strong:var(--dsw-alias-border-l3,#c6ccd4);--ad3-text:var(--dsw-alias-label-primary,var(--text-primary,#20242a));--ad3-muted:var(--dsw-alias-label-secondary,var(--text-secondary,#61666b));--ad3-caption:var(--dsw-alias-label-tertiary,#81858c);--ad3-accent:#3d7f68;--ad3-warning:var(--dsw-alias-state-warning-primary,#b27a31);--ad3-danger:var(--dsw-alias-state-error-primary,#b54a43);--ad3-hover:var(--dsw-alias-interactive-bg-hover,#0000000d);--ad3-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--ad3-blue:var(--dsw-alias-state-business-primary,#4d6bfe);--ad3-blue-soft:color-mix(in srgb,var(--ad3-blue) 12%,var(--dsw-specific-menu,var(--ad3-surface)));--ad3-blue-line:color-mix(in srgb,var(--ad3-blue) 55%,transparent);--ad3-ring:0 0 0 1px var(--ad3-blue-line);box-sizing:border-box;color:var(--ad3-text);font-size:13px;line-height:20px;font-family:inherit;color-scheme:light dark;-webkit-font-smoothing:antialiased}
/* The composer bar is the Goal dock's sibling: same width formula, same 36px
   height, same panel stroke/radius. Only the tint differs \u2014 the host's business
   blue, one step lighter than the goal card's menu surface. */
.ad3-dock{width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));max-width:min(calc(var(--dsh-composer-card-max-width,748px) - 4 * var(--dsh-composer-dock-inset,8px)),100%);margin:0 auto;border-radius:var(--dsw-radius-md,12px);background:transparent;box-shadow:inset 0 0 0 .5px var(--ad3-border-strong);overflow:hidden}
.ad3 *{box-sizing:border-box}
.ad3 button{border:0;border-radius:6px;background:transparent;color:var(--ad3-muted);cursor:pointer;font:inherit;transition:background-color 160ms ease,color 160ms ease}
.ad3 button:hover{background:var(--ad3-hover);color:var(--ad3-text)}
.ad3 button:disabled{opacity:.4;cursor:default;background:transparent}
.ad3 button:focus-visible{outline:2px solid var(--ad3-accent);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.ad3 *{transition:none!important;animation:none!important}}
.ad3-eyebrow{font-size:11px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ad3-muted);white-space:nowrap}
.ad3-num{font-family:var(--ad3-mono);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;letter-spacing:.01em;white-space:nowrap}
.ad3-bar{display:flex;align-items:center;height:36px;padding:4px 12px;gap:10px}
.ad3-toggle{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:2px 4px;text-align:left;overflow:hidden}
.ad3-toggle>svg:first-child{flex:none;color:var(--ad3-muted)}
.ad3-brand{flex:none;font-size:11px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ad3-muted)}
.ad3-where{flex:1 1 0;min-width:0;overflow:hidden;color:var(--ad3-text);font-size:13px;line-height:20px;text-overflow:ellipsis;white-space:nowrap}
.ad3-actions{display:flex;align-items:center;gap:6px;flex:none}
/* The bar is a set of marks, not a table: each mark keeps one sentence of
   evidence behind a pointer, so the strip can stay 36px tall. */
.ad3-tip-anchor{position:relative;display:inline-flex;align-items:center;min-width:0}
.ad3-tip-grow{display:flex;flex:1;min-width:0}
.ad3-tip-grow>.ad3-toggle{flex:1}
.ad3-flag{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border-radius:6px;color:var(--ad3-muted);cursor:pointer}
.ad3-flag:hover{background:var(--ad3-hover);color:var(--ad3-text)}
.ad3-flag.alert{color:var(--ad3-warning)}
.ad3-flag.alert:hover{color:var(--ad3-warning)}
.ad3-flag:focus-visible{outline:2px solid var(--ad3-accent);outline-offset:1px}
.ad3-tip{position:fixed;z-index:2147483000;display:block;width:max-content;max-width:min(320px,calc(100vw - 24px));padding:10px 12px;border-radius:10px;border:1px solid var(--ad3-border);background:var(--ad3-surface);box-shadow:0 10px 28px rgba(0,0,0,.18);color:var(--ad3-text);font-size:12px;line-height:19px;pointer-events:none;transform:translate(-50%,-100%);animation:ad3-tip-in 120ms ease-out}
.ad3-tip.below{transform:translate(-50%,0)}
.ad3-tip-title{display:block;margin:0 0 4px;font-size:11px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ad3-muted)}
.ad3-tip-line{display:block;margin:0;overflow-wrap:anywhere}
.ad3-tip-line+.ad3-tip-line{margin-top:4px}
@keyframes ad3-tip-in{from{opacity:0}to{opacity:1}}
.ad3-rail{flex:none;display:flex;align-items:center;gap:7px}
.ad3-rail>i{display:block;position:relative;width:44px;height:4px;border-radius:2px;background:color-mix(in srgb,var(--ad3-border-strong) 62%,transparent);overflow:hidden}
.ad3-rail>i>b{position:absolute;inset:0 auto 0 0;border-radius:2px;background:var(--ad3-accent);transition:width 240ms ease}
.ad3-pending{flex:none;color:var(--ad3-muted);font-size:12px;line-height:18px;white-space:nowrap}
.ad3-state{flex:none;display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;white-space:nowrap}
.ad3-state>i{display:block;width:5px;height:5px;border-radius:50%;background:currentColor}
.ad3-state.danger{color:var(--ad3-danger)}.ad3-state.warning{color:var(--ad3-warning)}.ad3-state.muted{color:var(--ad3-muted)}.ad3-state.accent{color:var(--ad3-accent)}
.ad3-warn{color:var(--ad3-warning)}
.ad3-board{display:flex;flex-direction:column;padding:0}
.ad3-head{display:flex;flex-direction:column;gap:8px;padding:12px 14px 10px}
.ad3-head-top{display:flex;align-items:center;gap:8px;min-width:0}
.ad3-head-top>.ad3-eyebrow{flex:none}
.ad3-head-top>.ad3-spacer{flex:1}
.ad3-goal-wrap{display:flex;flex-direction:column;gap:4px;min-width:0}
.ad3-goal{margin:0;font-size:15px;line-height:23px;font-weight:600;letter-spacing:-.005em;overflow-wrap:anywhere;text-wrap:pretty}
.ad3-goal.is-clamped{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}
.ad3 button.ad3-goal-more{align-self:flex-start;padding:0 2px;border-radius:4px;color:var(--ad3-muted);font-size:11px;line-height:16px}
.ad3 button.ad3-goal-more:hover{background:transparent;color:var(--ad3-text);text-decoration:underline}
.ad3-meta{display:flex;align-items:center;gap:12px;min-width:0;color:var(--ad3-muted);font-size:12px;line-height:18px;overflow:hidden;white-space:nowrap}
.ad3-meta>span{flex:none}
.ad3-meta>.ad3-flex{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.ad3-rule{height:.5px;margin:0;border:0;background:var(--ad3-border)}
.ad3-section{padding:10px 14px 12px;display:flex;flex-direction:column;gap:2px}
.ad3-section-head{display:flex;align-items:baseline;gap:8px;padding:0 0 4px}.ad3-section-head>.ad3-flex{flex:1}
.ad3-units{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
/* One packet is a short stack: the goal line, its newest progress line, and \u2014
   only when opened \u2014 the older lines. Every line shares one left edge for the
   text and one clock column, so opening never shifts anything sideways. */
.ad3-row{display:flex;flex-direction:column;gap:5px;padding:7px 8px;border-radius:7px;transition:background-color 160ms ease}
.ad3-row:hover{background:var(--ad3-hover)}
.ad3-row-head{display:flex;align-items:center;gap:8px;min-height:24px}
.ad3-row-head>.ad3-mark{flex:none;width:12px;font-family:var(--ad3-mono);font-size:13px;line-height:19px;text-align:center;color:var(--ad3-caption)}
.ad3-row-head>.ad3-goal-cell{flex:0 1 auto;min-width:0;font-size:13px;line-height:19px}
.ad3-row-head>.ad3-spacer{flex:1}
/* Not the pane's .ad3-goal class: that one is the 15px heading, and reusing it
   here silently inflated every packet row. */
.ad3-row-head>.ad3-goal-cell>.ad3-goal-text{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* How many lines the packet holds, sitting against the goal it belongs to: the
   accent tint is the panel's "there is more here" color, not a state. */
.ad3-count{flex:none;min-width:18px;padding:0 5px;border-radius:8px;background:color-mix(in srgb,var(--ad3-accent) 14%,transparent);color:var(--ad3-accent);font-size:11px;line-height:17px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums}
.ad3-row-wrap{list-style:none}
.ad3-note-wrap{list-style:none}
.ad3-row-openable{cursor:pointer}
.ad3-row-openable:focus-visible{outline:2px solid currentColor;outline-offset:-2px;border-radius:4px}
/* One progress line: dot, sentence, time. The time column is fixed width and
   tabular so every line in every packet lines up on the right. */
.ad3-note-line,.ad3-note-row{display:flex;align-items:baseline;gap:8px;padding-left:20px;font-size:12px;line-height:18px;color:var(--ad3-muted)}
.ad3-note-line>.ad3-dot,.ad3-note-row>.ad3-dot{flex:none;width:4px;height:4px;border-radius:50%;background:var(--ad3-caption);opacity:.75;transform:translateY(-1px)}
.ad3-note-line>.ad3-note-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ad3-note-row>.ad3-note-text{flex:1;min-width:0;overflow-wrap:anywhere}
.ad3-note-line>.ad3-clock,.ad3-note-row>.ad3-clock{flex:none;width:42px;text-align:right;font-family:var(--ad3-mono);font-size:11px;font-variant-numeric:tabular-nums;color:var(--ad3-muted);opacity:.85}
/* Older lines sit under the newest one at the same left edge (no extra inset)
   and stop at the same right edge, so the two blocks read as one column. */
.ad3-notes{list-style:none;margin:0;padding:0 8px;display:flex;flex-direction:column;gap:4px}
.ad3-row[data-state="done"] .ad3-mark{color:var(--ad3-accent);font-weight:600}
.ad3-row[data-state="done"] .ad3-goal-text{color:var(--ad3-muted);opacity:.72}
.ad3-row[data-state="active"]{background:transparent;box-shadow:inset 2px 0 0 var(--ad3-accent)}
.ad3-row[data-state="active"] .ad3-mark{color:var(--ad3-accent)}
.ad3-row[data-state="active"] .ad3-num{color:var(--ad3-accent)}
.ad3-mark-play{position:relative;color:transparent}
.ad3-mark-play::before{content:'';position:absolute;left:4px;top:7px;width:0;height:0;border-left:5px solid var(--ad3-accent);border-top:3.5px solid transparent;border-bottom:3.5px solid transparent}
.ad3-group[data-state="active"]>.ad3-group-head>.ad3-theme-state{color:var(--ad3-accent);background:color-mix(in srgb,var(--ad3-accent) 13%,transparent);border:.5px solid color-mix(in srgb,var(--ad3-accent) 42%,transparent);border-radius:6px;padding:0 6px;font-size:10.5px;line-height:16px}
.ad3-group[data-state="active"]>.ad3-group-head>.ad3-num{color:var(--ad3-accent)}
.ad3-row[data-state="active"] .ad3-goal-text{color:var(--ad3-text);font-weight:550}
.ad3-row .ad3-num{flex:none;color:var(--ad3-caption)}
.ad3-delegated{flex:none;font-family:var(--ad3-mono);font-size:11px;line-height:17px;color:var(--ad3-muted);border:1px solid var(--ad3-border);border-radius:4px;padding:0 5px;white-space:nowrap}
/* One breath, reserved: the mark of the unit in flight, the heading mark of a
   milestone holding it, and the dot of a running child are the only things that
   move. Stillness everywhere else is what makes this read as calm, not dead. */
@keyframes ad3-breathe{0%,100%{opacity:1}50%{opacity:.35}}
.ad3-row[data-state="active"]>.ad3-mark,.ad3-group[data-state="active"] .ad3-group-mark{animation:ad3-breathe 1.8s ease-in-out infinite}
.ad3-row[data-state="blocked"]>.ad3-mark{color:var(--ad3-danger)}
.ad3-groups{display:flex;flex-direction:column;gap:10px;margin:0}
.ad3-group{border:.5px solid var(--ad3-border);border-radius:10px;background:transparent;overflow:hidden}
.ad3-group-daily{border-style:dashed;background:transparent}.ad3-group-daily>.ad3-group-head{padding:8px 12px;opacity:.78}.ad3-group-daily>.ad3-group-head:hover{opacity:1}.ad3-group-daily>.ad3-group-head>.ad3-group-label{font-size:12px;font-weight:500;color:var(--ad3-muted)}.ad3-group-daily>.ad3-group-head>.ad3-theme-state{font-size:10px;color:var(--ad3-caption)}.ad3-group-head{display:flex;align-items:center;gap:8px;width:100%;padding:12px 13px 10px;text-align:left;color:var(--ad3-text)}
.ad3-group-head:hover{background:var(--ad3-hover)}
.ad3-group[data-folded="true"]>.ad3-group-head{padding-bottom:12px}
.ad3-group-head>.ad3-group-label{flex:1;font-size:15px;line-height:22px;font-weight:650;letter-spacing:-.01em;color:var(--ad3-text)}
.ad3-group[data-state="active"]>.ad3-group-head>.ad3-group-label{color:var(--ad3-accent)}
.ad3-group-toggle:hover{background:transparent;color:var(--ad3-text)}
.ad3-caret{flex:none;width:12px;color:var(--ad3-caption);font-size:15px;line-height:16px;text-align:center;transform:rotate(0deg);transition:transform .12s ease}
.ad3-caret[data-open="true"]{transform:rotate(90deg)}
.ad3-inline-note{margin-left:8px;font-size:12px}
.ad3-band{padding:0}
.ad3-band-head{display:flex;align-items:center;gap:8px;margin-bottom:9px}
.ad3-asset{display:flex;align-items:baseline;gap:12px;padding:4px 0;font-size:12px;line-height:18px}
.ad3-asset-label{flex:none;width:42px;color:var(--ad3-muted);font-size:11px;line-height:16px;letter-spacing:.04em}
.ad3-asset-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ad3-text)}
.ad3-mono-value{font-family:var(--ad3-mono);font-size:11.5px;font-variant-numeric:tabular-nums}
.ad3-gates{display:flex;gap:6px}
.ad3-gate{padding:0 6px;border:1px solid var(--ad3-border);border-radius:4px;font-size:11px;line-height:17px;color:var(--ad3-muted)}
.ad3-gate.on{border-color:color-mix(in srgb,var(--ad3-accent) 45%,var(--ad3-border));color:var(--ad3-accent)}
.ad3-group-mark{flex:none;width:12px;text-align:center;font-family:var(--ad3-mono);font-size:13px;line-height:18px;color:var(--ad3-caption)}
.ad3-group-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:19px;font-weight:600;letter-spacing:-.002em;color:var(--ad3-text)}
.ad3-group .ad3-units{padding:0 0 7px}
.ad3-group .ad3-row{padding:6px 13px;border-radius:0;min-height:32px;border-top:.5px solid color-mix(in srgb,var(--ad3-border) 70%,transparent)}
.ad3-group .ad3-row>.ad3-row-head>.ad3-goal-cell{font-size:12.5px;line-height:18px;color:var(--ad3-muted)}
.ad3-group .ad3-row[data-state="active"] .ad3-goal-text,.ad3-group .ad3-row[data-state="done"] .ad3-goal-text{color:var(--ad3-text)}
.ad3-group .ad3-row[data-state="active"]{box-shadow:inset 2px 0 0 var(--ad3-accent);background:transparent}
.ad3-group[data-state="done"] .ad3-group-label{color:var(--ad3-muted)}
.ad3-group[data-state="done"] .ad3-group-mark{color:var(--ad3-accent)}
.ad3-group[data-state="active"]{border-color:color-mix(in srgb,var(--ad3-accent) 38%,var(--ad3-border))}
.ad3-group[data-state="active"]{background:color-mix(in srgb,var(--ad3-accent) 12%,transparent);border-color:color-mix(in srgb,var(--ad3-accent) 38%,var(--ad3-border))}.ad3-row[data-state="done"] .ad3-mark{color:var(--ad3-accent)}.ad3-row[data-state="done"] .ad3-goal-text{color:var(--ad3-muted)}
.ad3-group[data-state="active"] .ad3-group-head{background:transparent}
.ad3-group[data-state="active"] .ad3-group-mark{color:var(--ad3-accent)}
.ad3-group[data-state="blocked"]{border-color:color-mix(in srgb,var(--ad3-danger) 34%,var(--ad3-border))}
.ad3-group[data-state="blocked"] .ad3-group-mark{color:var(--ad3-danger)}
.ad3-group-loose .ad3-units{padding:2px 0 5px}
.ad3-row.ad3-pending-row{color:var(--ad3-caption);border-left:1px dashed color-mix(in srgb,var(--ad3-border-strong) 80%,transparent);margin-left:6px;padding-left:16px;border-radius:0 6px 6px 0}
.ad3-row.ad3-pending-row>.ad3-row-head>.ad3-goal-cell{font-size:13px}
.ad3-last{display:flex;flex-direction:column;gap:6px;padding:10px 14px 13px}
.ad3-last-line{display:flex;align-items:center;gap:8px}
.ad3-summary{margin:0;color:var(--ad3-muted);font-size:13px;line-height:20px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;overflow-wrap:anywhere}
.ad3-note{margin:0;color:var(--ad3-muted);font-size:12px;line-height:18px}
.ad3-empty{padding:24px 18px;display:flex;flex-direction:column;gap:10px}
/* The board lives in a pane, not in the composer: it must not draw a second card
   around itself, and its padding is what keeps it off the pane edges. */
.ad3-pane{width:auto;max-width:none;margin:0;border:0;border-radius:0;background:transparent;box-shadow:none;flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:20px 18px 32px;display:flex;flex-direction:column;gap:24px}
.ad3-pane .ad3-head{padding:0;gap:10px}
.ad3-pane .ad3-goal{font-size:15px;line-height:23px}
.ad3-pane .ad3-section{padding:0;gap:12px}
.ad3-pane .ad3-section-head{padding:0}
.ad3-pane .ad3-last{padding:0;gap:8px}
.ad3-pane .ad3-rule{display:none}
.ad3-pane .ad3-meta{gap:12px}
.ad3-under{margin:0;color:var(--ad3-muted);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.ad3-tl{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.ad3-tl-item{border-top:.5px solid var(--ad3-border)}
.ad3-tl-item:first-child{border-top:0}
.ad3-tl-head{display:flex;align-items:center;gap:8px;width:100%;padding:8px 4px;border-radius:7px;text-align:left;min-width:0;background:none;border:0;color:var(--ad3-text);font:inherit}
.ad3-tl-head:hover{background:var(--ad3-hover)}
.ad3-tl-when{flex:none;font-family:var(--ad3-mono);font-size:11px;line-height:16px;color:var(--ad3-caption);font-variant-numeric:tabular-nums}
.ad3-tl-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--ad3-border-strong)}
.ad3-tl-item[data-state="active"] .ad3-tl-dot{background:var(--ad3-accent)}
.ad3-tl-goal{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;line-height:18px}
.ad3-tl-item[data-state="closed"] .ad3-tl-goal,.ad3-tl-item[data-state="cancelled"] .ad3-tl-goal{color:var(--ad3-muted)}
.ad3-tl-item[data-current="true"] .ad3-tl-goal{font-weight:600}
.ad3-tl-now{flex:none;font-size:10px;line-height:16px;padding:0 5px;border-radius:6px;background:color-mix(in srgb,var(--ad3-accent) 14%,transparent);color:var(--ad3-accent)}
.ad3-tl-meta{flex:none;color:var(--ad3-caption);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.ad3-tl-units{list-style:none;margin:0 0 8px;padding:0 0 0 22px;display:flex;flex-direction:column;gap:3px}
.ad3-tl-unit{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;line-height:18px;color:var(--ad3-muted)}
.ad3-tl-unit>.ad3-mark{flex:none;width:12px;text-align:center;color:var(--ad3-caption);font-family:var(--ad3-mono)}
.ad3-tl-unit[data-state="done"]>.ad3-mark{color:var(--ad3-accent)}
.ad3-tl-unit-goal{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ad3-tl-parent{flex:none;font-family:var(--ad3-mono);font-size:10.5px;color:var(--ad3-caption)}
.ad3-facts{border-top:.5px solid var(--ad3-border);padding-top:16px}
.ad3-facts>summary{cursor:pointer;list-style:none;color:var(--ad3-muted);font-size:11px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.ad3-facts>summary::-webkit-details-marker{display:none}
.ad3-facts>summary:hover{color:var(--ad3-text)}
.ad3-facts-body{display:flex;flex-direction:column;padding-top:12px}
@media(max-width:560px){.ad3-pane{padding:18px 16px 28px}}
@media(prefers-color-scheme:dark){.ad3{--ad3-bg:var(--dsw-alias-bg-base,#17191c);--ad3-surface:var(--dsw-specific-tip,#202328);--ad3-border:var(--dsw-alias-border-l1,#373c44);--ad3-border-strong:var(--dsw-alias-border-l3,#4a515b);--ad3-text:var(--dsw-alias-label-primary,#e7e9ec);--ad3-muted:var(--dsw-alias-label-secondary,#cfd3d6);--ad3-caption:var(--dsw-alias-label-tertiary,#adb2b8);--ad3-accent:#67b394;--ad3-hover:#ffffff12}}
body[data-ds-dark-theme] .ad3 .ad3-group[data-state="active"]{background:rgba(103,179,148,.11);border-color:rgba(103,179,148,.4)}
body[data-ds-dark-theme] .ad3 .ad3-group[data-state="active"] .ad3-group-head{background:rgba(103,179,148,.09)}
body[data-ds-dark-theme] .ad3 .ad3-row[data-state="active"]{box-shadow:inset 2px 0 0 #67b394}
body[data-ds-dark-theme] .ad3 .ad3-row[data-state="done"] .ad3-mark{color:#67b394}
body[data-ds-dark-theme] .ad3 .ad3-row[data-state="active"] .ad3-num{color:#67b394}
body[data-ds-dark-theme] .ad3 .ad3-group[data-state="active"]>.ad3-group-head>.ad3-group-label{color:#67b394}
body[data-ds-dark-theme] .ad3 .ad3-group[data-state="active"]>.ad3-group-head>.ad3-theme-state{color:#67b394;background:rgba(103,179,148,.16);border-color:rgba(103,179,148,.44)}
body[data-ds-dark-theme] .ad3 .ad3-group[data-state="active"]>.ad3-group-head>.ad3-num{color:#67b394}
body[data-ds-dark-theme] .ad3 .ad3-row[data-state="done"] .ad3-goal-text{color:rgba(231,233,236,.52);opacity:.9}
/* Only the row in flight is an item; everything else is a line. Lines share one
   height, so a card reads as a short stack instead of a ragged column \u2014 and the
   one row that moves is the one that is taller. */
.ad3-row[data-state="active"]{padding-top:6px;padding-bottom:6px;min-height:32px}
.ad3-row[data-state="active"] .ad3-row-head{min-height:24px}
.ad3-row:not([data-state="active"]){padding-top:3px;padding-bottom:3px;min-height:23px}
.ad3-row:not([data-state="active"]) .ad3-row-head{min-height:17px;gap:7px}
.ad3-row:not([data-state="active"]) .ad3-mark{font-size:11px;line-height:15px}
.ad3-row[data-state="done"] .ad3-goal-text{color:var(--ad3-muted);opacity:.72}
body[data-ds-dark-theme] .ad3 .ad3-row[data-state="done"] .ad3-goal-text{color:rgba(231,233,236,.5);opacity:.85}
body[data-ds-dark-theme] .ad3{--ad3-bg:var(--dsw-alias-bg-base,#17191c);--ad3-surface:var(--dsw-specific-tip,#202328);--ad3-border:var(--dsw-alias-border-l1,#373c44);--ad3-border-strong:var(--dsw-alias-border-l3,#4a515b);--ad3-text:var(--dsw-alias-label-primary,#e7e9ec);--ad3-muted:var(--dsw-alias-label-secondary,#cfd3d6);--ad3-caption:var(--dsw-alias-label-tertiary,#adb2b8);--ad3-accent:#67b394;--ad3-hover:#ffffff12}
.ad3-deliv{font-size:9.5px;letter-spacing:.08em;padding:1px 4px;border-radius:4px;border:1px solid var(--ad3-border-strong);color:var(--ad3-caption)}
/* A count that is a fact about the whole task, not a warning: it sits where the
   actions sit, because that is the row a person scans. */
.ad3-chip{font-size:11px;line-height:18px;padding:0 7px;border-radius:999px;border:.5px solid var(--ad3-border-strong);color:var(--ad3-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
/* What the unit in flight owes. One line, the same sentence the record holds. */
.ad3-row-promise{display:flex;align-items:baseline;gap:7px;padding:1px 0 2px 20px;font-size:12px;line-height:17px;min-width:0}
.ad3-promise-label{flex:none;font-size:10.5px;line-height:15px;color:var(--ad3-caption);letter-spacing:.04em}
.ad3-promise-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ad3-muted)}
/* A sealed theme is a fact, not a place to work: it reads as one quiet line
   until somebody opens it again. */
.ad3-group[data-state="done"]{border-color:color-mix(in srgb,var(--ad3-border) 60%,transparent);background:transparent}
.ad3-group[data-state="done"]>.ad3-group-head{padding:9px 13px;gap:7px}
.ad3-group[data-state="active"] .ad3-group-head{background:color-mix(in srgb,var(--ad3-accent) 8%,transparent)}
.ad3-group[data-state="done"]>.ad3-group-head:hover{background:var(--ad3-hover)}
.ad3-theme-state{flex:none;font-size:10.5px;line-height:16px;color:var(--ad3-caption)}
.ad3-theme-state[data-state="done"]{color:var(--ad3-accent)}
.ad3-theme-state[data-state="active"]{color:var(--ad3-accent)}
.ad3-seals{display:inline-flex;align-items:center;gap:2px;font-size:10px;color:var(--ad3-caption)}
.ad3-seal{opacity:.4}
.ad3-seal[data-on=true]{opacity:1;color:var(--ad3-accent)}
.ad3-ask{font-size:10px;padding:0 5px;border-radius:4px;color:#9a7420;border:1px solid #9a742055}
/* Receipts. Everything dsh-auto-dev puts into the conversation is a translucent
   capsule in its tone, so a person tells the plugin's word from the model's at a
   glance: a state change is a card, procedure a one-line pill. The tint stays
   light (7\u20138%) so ten method hints still never outweigh one delivery. */
.ad3{--ad3-tip:#3f74c9}
@media(prefers-color-scheme:dark){.ad3{--ad3-tip:#7ea6e8}}
body[data-ds-dark-theme] .ad3{--ad3-tip:#7ea6e8}
.ad3-ev{--ad3-tone:var(--ad3-accent);margin:8px 0;padding:10px 14px 10px 12px;border-radius:14px;background:color-mix(in srgb,var(--ad3-tone) 7%,transparent);box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--ad3-tone) 30%,transparent)}
.ad3-ev[data-tone=ask]{--ad3-tone:var(--ad3-warning)}
.ad3-ev[data-tone=blocked]{--ad3-tone:var(--ad3-danger)}
.ad3-ev[data-tone=guard]{--ad3-tone:var(--ad3-warning)}
.ad3-ev[data-tone=info],.ad3-ev[data-tone=neutral]{--ad3-tone:var(--ad3-tip)}
.ad3-ev-head{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;line-height:20px;font-weight:600;color:var(--ad3-text)}
.ad3-ev-dot{flex:none;width:7px;height:7px;margin:0 2px 0 1px;border-radius:50%;background:var(--ad3-tone);box-shadow:0 0 0 3px color-mix(in srgb,var(--ad3-tone) 16%,transparent)}
.ad3-ev-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ad3-ev-spacer{flex:1}
.ad3-ev-meta,.ad3-ev-tag{flex:none;font-size:11px;line-height:16px;color:var(--ad3-caption);font-variant-numeric:tabular-nums;white-space:nowrap}
.ad3-ev-body{display:flex;align-items:baseline;gap:10px;margin-top:2px;padding-left:18px;min-width:0}
.ad3-ev-line{flex:1;min-width:0;font-size:12.5px;line-height:19px;color:var(--ad3-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ad3-ev-warn{display:flex;align-items:baseline;gap:7px;margin:8px 0 0 18px;padding-top:7px;border-top:.5px solid var(--ad3-border);font-size:12px;line-height:18px;color:var(--ad3-text);min-width:0}
.ad3-ev-warn>b{flex:none;font-weight:700;color:var(--ad3-warning)}
.ad3-ev-warn>span:first-of-type{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ad3-ev-more{flex:none;font-size:11px;color:var(--ad3-caption);font-variant-numeric:tabular-nums}
.ad3-ev-row{--ad3-tone:var(--ad3-tip);display:flex;align-items:center;gap:8px;min-width:0;margin:4px 0;padding:4px 12px;border-radius:999px;font-size:12px;line-height:18px;color:var(--ad3-caption);background:color-mix(in srgb,var(--ad3-tone) 8%,transparent);box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--ad3-tone) 26%,transparent)}
.ad3-ev-row .ad3-ev-glyph{flex:none;width:12px;text-align:center;font-size:10.5px;color:var(--ad3-tone)}
.ad3-ev-row .ad3-ev-title{flex:none;color:var(--ad3-muted);font-weight:500}
.ad3-ev-row .ad3-ev-line{color:var(--ad3-caption);font-size:12px;line-height:18px}
.ad3-ev-row[data-tone=ask]{--ad3-tone:var(--ad3-warning)}
.ad3-ev-row[data-tone=blocked]{--ad3-tone:var(--ad3-danger)}
.ad3-ev-row[data-tone=done],.ad3-ev-row[data-tone=open]{--ad3-tone:var(--ad3-accent)}
/* The plugin said no to a call. It is the one row that speaks up: a person who
   only sees the failed tool call above it would read it as the agent stuck. */
.ad3-ev-row[data-tone=guard]{--ad3-tone:var(--ad3-warning);margin:6px 0;padding:6px 12px;border-radius:999px;background:color-mix(in srgb,var(--ad3-warning) 8%,transparent);box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--ad3-warning) 30%,transparent)}
.ad3-ev-row[data-tone=guard] .ad3-ev-title{color:var(--ad3-warning);font-weight:600}
.ad3-ev-row[data-tone=guard] .ad3-ev-line{color:var(--ad3-text)}
/* Dock pulse: the unit in flight, how long it has run, and the last check. */
.ad3-pulse{flex:none;display:inline-flex;align-items:center;gap:8px;padding:0 9px;height:22px;border-radius:999px;background:color-mix(in srgb,var(--ad3-text) 5%,transparent);font-size:11.5px;line-height:16px;color:var(--ad3-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.ad3-pulse>b{font-family:var(--ad3-mono);font-weight:600;color:var(--ad3-accent)}
.ad3-pulse>code{font-family:var(--ad3-mono);font-size:11px;color:var(--ad3-text)}
.ad3-pulse>i{font-style:normal;font-weight:700}
.ad3-pulse[data-ok=true]>i{color:var(--ad3-accent)}
.ad3-pulse[data-ok=false]{background:color-mix(in srgb,var(--ad3-danger) 9%,transparent)}
.ad3-pulse[data-ok=false]>i,.ad3-pulse[data-ok=false]>em{color:var(--ad3-danger)}
.ad3-pulse>em{font-style:normal}
/* A claim is either backed by a recorded execution or it is the agent's word. */
.ad3-claims{list-style:none;margin:2px 0 4px;padding:0 0 0 20px;display:flex;flex-direction:column;gap:5px}
.ad3-claim{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:12px;line-height:18px;color:var(--ad3-muted)}
.ad3-claim>span:last-child{min-width:0;overflow-wrap:anywhere}
.ad3-proof{flex:none;padding:0 6px;border-radius:5px;font-size:10.5px;line-height:16px;font-weight:600;letter-spacing:.02em}
.ad3-proof[data-proven=true]{color:var(--ad3-accent);background:color-mix(in srgb,var(--ad3-accent) 13%,transparent)}
.ad3-proof[data-proven=false]{color:var(--ad3-caption);box-shadow:inset 0 0 0 .5px var(--ad3-border-strong)}
.ad3-proofs{flex:none;font-size:10.5px;line-height:16px;color:var(--ad3-caption);font-variant-numeric:tabular-nums}
.ad3-proofs[data-weak=true]{color:var(--ad3-warning)}
/* Panel polish: a pill for state, a heavier goal, and the last delivery as the
   one card on the page. */
.ad3-pane .ad3-state{height:22px;padding:0 9px;border-radius:999px;background:color-mix(in srgb,currentColor 11%,transparent);font-weight:500}
.ad3-pane .ad3-goal{font-size:16px;line-height:24px;font-weight:650;letter-spacing:-.01em}
.ad3-pane .ad3-meta{gap:0;color:var(--ad3-caption);font-size:11.5px}
.ad3-pane .ad3-meta>span+span::before{content:'\xB7';margin:0 8px;color:var(--ad3-border-strong)}
.ad3-pane .ad3-last{padding:14px 16px;border-radius:12px;background:var(--ad3-surface);box-shadow:0 0 0 .5px var(--ad3-border-strong),0 1px 2px rgba(15,20,25,.04)}
.ad3-outcome{flex:none;height:20px;padding:0 8px;border-radius:999px;font-size:11px;line-height:20px;font-weight:600;color:var(--ad3-accent);background:color-mix(in srgb,var(--ad3-accent) 12%,transparent)}
.ad3-outcome[data-outcome=partial]{color:var(--ad3-warning);background:color-mix(in srgb,var(--ad3-warning) 12%,transparent)}
.ad3-outcome[data-outcome=blocked],.ad3-outcome[data-outcome=failed]{color:var(--ad3-danger);background:color-mix(in srgb,var(--ad3-danger) 11%,transparent)}
.ad3-pane .ad3-summary{color:var(--ad3-text);font-size:12.5px;line-height:20px}
.ad3-last-warn{display:flex;gap:7px;margin:2px 0 0;font-size:12px;line-height:18px;color:var(--ad3-text)}
.ad3-last-warn>b{flex:none;color:var(--ad3-warning)}
.ad3-facts>summary{display:flex;align-items:center;gap:6px}
/* The theme in flight is outlined, not filled: a green slab under every row
   made the active card the loudest thing on the page. */
.ad3-pane .ad3-group[data-state="active"],body[data-ds-dark-theme] .ad3-pane .ad3-group[data-state="active"]{background:var(--ad3-surface);border-color:color-mix(in srgb,var(--ad3-accent) 34%,var(--ad3-border));box-shadow:0 1px 2px rgba(15,20,25,.04)}
.ad3-pane .ad3-group[data-state="active"] .ad3-group-head,body[data-ds-dark-theme] .ad3-pane .ad3-group[data-state="active"] .ad3-group-head{background:transparent}
.ad3-pane .ad3-group[data-state="active"]>.ad3-group-head>.ad3-group-label,body[data-ds-dark-theme] .ad3-pane .ad3-group[data-state="active"]>.ad3-group-head>.ad3-group-label{color:var(--ad3-text)}
.ad3-facts>summary::before{content:'\u203A';display:inline-block;width:10px;font-size:14px;color:var(--ad3-caption);transition:transform .12s ease}
.ad3-facts[open]>summary::before{transform:rotate(90deg)}
@media(max-width:560px){.ad3-brand,.ad3-rail>i{display:none}.ad3-state{font-size:12px}}
`;
function Icon({ name }) {
  const paths = {
    task: "M5 3h8v11H3V3h2m1-1h4v3H6V2m0 6h4m-4 3h4",
    archive: "M2.5 3.5h11v3h-11v-3Zm1 3h9v6h-9v-6Zm3 2.5h3",
    alert: "M8 2.5 14.5 13.5h-13L8 2.5Zm0 3.6v3.4m0 2.1h.01"
  };
  return h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.25, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: paths[name] }));
}
function Tip({ detail, className = "", children }) {
  const [at, setAt] = (0, import_react.useState)(null);
  const ref = (0, import_react.useRef)(null);
  const show = () => {
    if (!detail) return;
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const half = 168;
    const x = Math.min(Math.max(rect.left + rect.width / 2, half + 10), window.innerWidth - half - 10);
    const above = rect.top > 140;
    setAt({ x, y: above ? rect.top - 8 : rect.bottom + 8, above });
  };
  const hide = () => setAt(null);
  return h(
    "span",
    {
      ref,
      className: `ad3-tip-anchor ${className}`,
      onMouseEnter: show,
      onMouseLeave: hide,
      onFocus: show,
      onBlur: hide,
      onKeyDown: (event) => {
        if (event.key === "Escape") hide();
      }
    },
    children,
    at ? h(
      "span",
      {
        className: `ad3-tip${at.above ? "" : " below"}`,
        role: "tooltip",
        style: { left: `${at.x}px`, top: `${at.y}px` }
      },
      detail.title ? h("span", { className: "ad3-tip-title" }, detail.title) : null,
      (detail.lines ?? []).filter(Boolean).map((line, index) => h("span", { key: index, className: "ad3-tip-line" }, line))
    ) : null
  );
}
function Rail({ done, total, pending, label }) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  if (total <= 0 && pending <= 0) return label ? h("span", { className: "ad3-num" }, label) : null;
  return h(
    "span",
    { className: "ad3-rail" },
    total > 0 ? h("i", { role: "img", "aria-label": `\u8FDB\u5EA6 ${done}/${total}` }, h("b", { style: { width: `${Math.round(ratio * 100)}%` } })) : null,
    total > 0 ? h("span", { className: "ad3-num" }, `${done}/${total}`) : null,
    pending > 0 ? h("span", { className: "ad3-pending" }, pending && total <= 0 ? `${pending} \u4E2A\u91CC\u7A0B\u7891\u5F85\u5C55\u5F00` : `+${pending} \u5F85\u5C55\u5F00`) : null
  );
}
function State({ state }) {
  const [word, tone] = pillOf(state);
  return h("span", { className: `ad3-state ${tone}`, role: "status" }, h("i", null), word);
}
function Bar({ useProjection, openBoard }) {
  const state = useProjection("dshAutoDev");
  if (!state) return null;
  const where = headline(state);
  const counting = state.counting ?? {};
  const done = counting.done ?? 0;
  const total = counting.total ?? 0;
  const units = state.units ?? [];
  const active = units.find((unit) => unit.state === "active");
  const next = units.find((unit) => unit.state === "pending");
  const warns = warningLines(state);
  const checkpoint = state.assets?.checkpoint?.ref;
  const themes = (state.milestones ?? []).filter((group) => group.role !== "daily");
  const themesDone = themes.filter((group) => group.state === "done").length;
  const [word] = pillOf(state);
  const rail = h(Rail, { done, total, pending: state.pendingMilestones ?? 0, label: counting.label });
  const pulse = live(state) && state.pulse?.unit ? state.pulse : null;
  const flag = (label, icon, cls) => h("button", {
    type: "button",
    className: `ad3-flag${cls ? ` ${cls}` : ""}`,
    "aria-label": label,
    onClick: openBoard
  }, h(Icon, { name: icon }));
  return h(
    "section",
    { className: "ad3 ad3-dock", "aria-label": "Auto Dev \u4EFB\u52A1" },
    h("style", null, css),
    h(
      "div",
      { className: "ad3-bar" },
      h(Tip, {
        className: "ad3-tip-grow",
        detail: {
          title: `${laneWord(state)} \xB7 ${word}`,
          lines: [
            state.goal || state.request || "",
            state.next && state.next !== state.goal ? `\u4E0B\u4E00\u6B65 \xB7 ${state.next}` : "",
            state.project ? `\u9879\u76EE \xB7 ${state.project}` : ""
          ]
        }
      }, h(
        "button",
        { type: "button", className: "ad3-toggle", onClick: openBoard, "aria-label": "\u6253\u5F00 Auto Dev \u770B\u677F" },
        h(Icon, { name: "task" }),
        h("span", { className: "ad3-brand" }, "Auto Dev"),
        h("span", { className: "ad3-where" }, where || "\u5C1A\u672A\u5F00\u59CB")
      )),
      h(
        "div",
        { className: "ad3-actions" },
        pulse ? h(Tip, {
          detail: {
            title: `${pulse.unit} \xB7 ${elapsedWord(pulse.since)}`,
            lines: [
              pulse.check ? `\u6700\u8FD1\u4E00\u6B21\u68C0\u67E5 \xB7 ${pulse.check.command} \xB7 ${pulse.check.ok ? "\u901A\u8FC7" : "\u6CA1\u901A\u8FC7"}` : "\u8FD8\u6CA1\u8DD1\u8FC7\u68C0\u67E5",
              pulse.check && pulse.check.count > 1 ? `\u8FD9\u6761\u547D\u4EE4\u5DF2\u7ECF\u8DD1\u4E86 ${pulse.check.count} \u6B21` : ""
            ]
          }
        }, h(
          "span",
          { className: "ad3-pulse", "data-ok": pulse.check ? String(Boolean(pulse.check.ok)) : void 0 },
          h("b", null, pulse.unit),
          h("span", null, elapsedWord(pulse.since)),
          pulse.check ? h("code", null, pulse.check.command) : null,
          pulse.check ? h("i", null, pulse.check.ok ? "\u2713" : "\u2715") : null,
          pulse.check && pulse.check.count > 1 ? h("em", null, `\u7B2C ${pulse.check.count} \u6B21`) : null
        )) : null,
        // One theme is the task itself; a count of one says nothing.
        themes.length > 1 ? h(Tip, {
          detail: {
            title: `\u4E3B\u9898 ${themesDone}/${themes.length}`,
            lines: themes.map((group) => `${group.state === "done" ? "\u5DF2\u6536" : group.state === "active" ? "\u8FDB\u884C\u4E2D" : "\u672A\u5F00\u59CB"} \xB7 ${group.label}`)
          }
        }, h("span", { className: "ad3-chip" }, `\u4E3B\u9898 ${themesDone}/${themes.length}`)) : null,
        rail ? h(Tip, {
          detail: {
            title: total > 0 ? `\u8FDB\u5EA6 ${done}/${total}` : counting.label || "\u8BA1\u5212",
            lines: [
              total > 0 ? `\u5DF2\u5B8C\u6210 ${done} \u4E2A packet\uFF0C\u5171 ${total} \u4E2A\u3002` : "\u8FD9\u4EFD\u8BA1\u5212\u8FD8\u6CA1\u6709 packet\u3002",
              active ? `\u6B63\u5728\u505A ${active.id} \xB7 ${active.goal}` : next ? `\u4E0B\u4E00\u4E2A ${next.id} \xB7 ${next.goal}` : "",
              active?.note ? `\u6700\u65B0 \xB7 ${active.note}` : ""
            ]
          }
        }, rail) : null,
        state.checkpoints ? h(Tip, {
          detail: {
            title: `\u5B58\u6863\u70B9 ${state.checkpoints} \u4E2A`,
            lines: [
              checkpoint ? `\u6700\u8FD1\u4E00\u6B21 \xB7 ${checkpoint}` : "\u5BBF\u4E3B\u8FD8\u6CA1\u6709\u8BB0\u5F55\u5FEB\u7167\u5F15\u7528\u3002",
              "\u6BCF\u4E2A\u5B58\u6863\u70B9\u90FD\u662F\u6539\u52A8\u524D\u540E\u7684\u5FEB\u7167\uFF0C\u53EF\u4EE5\u5728\u770B\u677F\u91CC\u56DE\u6EDA\u3002"
            ]
          }
        }, flag(`\u5B58\u6863\u70B9 ${state.checkpoints} \u4E2A`, "archive")) : null,
        state.warnings && warns.length ? h(Tip, {
          detail: {
            title: warningsLabel(state.warnings),
            lines: [...warns.slice(0, 6), warns.length > 6 ? `\u8FD8\u6709 ${warns.length - 6} \u6761\u2026` : ""]
          }
        }, flag(warningsLabel(state.warnings), "alert", "alert")) : null,
        h(Tip, {
          detail: {
            title: `${laneWord(state)} \xB7 ${word}`,
            lines: settledState(state) === "active" ? ["\u4EFB\u52A1\u8FDB\u884C\u4E2D\uFF1A\u65B0\u7684 note\u3001\u63D0\u4EA4\u548C\u5B58\u6863\u70B9\u4F1A\u7EE7\u7EED\u5199\u8FDB\u8D26\u672C\u3002", total > 0 ? `\u8FDB\u5EA6 ${done}/${total}\u3002` : ""] : settledState(state) === "paused" ? ["\u4EFB\u52A1\u5DF2\u6682\u505C\uFF0C\u8D26\u672C\u548C\u770B\u677F\u90FD\u4FDD\u7559\u3002", "\u7528 /dsh-auto-dev resume \u6062\u590D\u3002"] : settledState(state) === "cancelled" ? ["\u4EFB\u52A1\u5DF2\u53D6\u6D88\uFF1A\u4E4B\u540E\u7684 work_submit \u4F1A\u88AB\u62D2\u7EDD\u3002", "\u8BB0\u5F55\u548C\u8BC1\u636E\u4ECD\u4FDD\u7559\uFF1B\u8981\u7EE7\u7EED\u8BF7\u65B0\u5F00\u4EFB\u52A1\u3002"] : [state.last ? `\u6700\u540E\u4E00\u6B21\u7ED3\u679C\uFF1A${outcomeWord(state.last.outcome)}\u3002` : "\u4EFB\u52A1\u5DF2\u7ED3\u675F\u3002", state.last?.summary ?? ""]
          }
        }, h(State, { state }))
      )
    )
  );
}
var CARD_FORM = /* @__PURE__ */ new Set(["unit-start", "unit-done", "unit-blocked", "ask", "task-done", "alternative", "review"]);
var formGlyph = {
  "unit-start": "\u25C7",
  "unit-open": "\u25C7",
  "unit-done": "\u25C6",
  "unit-blocked": "\u2715",
  ask: "\u25CC",
  "task-done": "\u2713",
  save: "\u2913",
  "theme-open": "\u25FB",
  "theme-seal": "\u25FC",
  handoff: "\u2913",
  postmortem: "\u21BA",
  remember: "\u270E",
  review: "\u2611",
  "review-done": "\u2611",
  "review-revise": "\u21BA",
  halt: "\u23F8",
  "organize-done": "\u2317",
  "read-doc": "\u25A4",
  "verify-start": "\u25B7",
  env: "\u2302",
  "env-forget": "\u232B",
  "organize-proposed": "\u2317",
  "blocked-call": "\u2298"
};
var formWord = {
  "unit-start": "\u5F00\u59CB",
  "unit-open": "\u5F00\u59CB",
  "unit-done": "\u5B8C\u6210",
  "unit-blocked": "\u6CA1\u901A\u8FC7",
  ask: "\u7B49\u4F60\u56DE\u7B54",
  "task-done": "\u4EFB\u52A1\u5B8C\u6210",
  save: "\u5B58\u6863",
  "theme-open": "\u65B0\u4E3B\u9898",
  "theme-seal": "\u4E3B\u9898\u5B8C\u6210",
  handoff: "\u63A5\u624B",
  postmortem: "\u590D\u76D8",
  remember: "\u8BB0\u4F4F",
  review: "\u505A\u5B8C\u4E86",
  "review-done": "\u5DF2\u6536\u6848",
  "review-revise": "\u6309\u610F\u89C1\u6539",
  halt: "\u505C\u4E00\u4E0B",
  "organize-done": "\u5DF2\u6574\u7406",
  "read-doc": "\u65B9\u6CD5\u63D0\u793A",
  "verify-start": "\u5F85\u9A8C\u8BC1",
  env: "\u8BB0\u4E0B\u73AF\u5883",
  "env-forget": "\u73AF\u5883\u66F4\u65B0",
  "organize-proposed": "\u6574\u7406\u63D0\u6848",
  "blocked-call": "\u62E6\u4E0B"
};
var TONE_OF = {
  "unit-blocked": "blocked",
  ask: "ask",
  alternative: "ask",
  review: "ask",
  postmortem: "ask",
  "organize-proposed": "ask",
  "blocked-call": "guard",
  "read-doc": "neutral",
  "verify-start": "neutral",
  "ui-plan": "neutral"
};
var isPath = (text) => /\.(md|mjs|js|json)$/.test(text);
function ensureCss() {
  if (typeof document === "undefined" || document.getElementById("ad3-css")) return;
  const style = document.createElement("style");
  style.id = "ad3-css";
  style.textContent = css;
  document.head.appendChild(style);
}
function StreamCard({ node }) {
  ensureCss();
  const data = node?.data ?? {};
  const form = data.form;
  const box = data.data ?? {};
  const tone = box.tone ?? TONE_OF[form] ?? form ?? "neutral";
  const title = box.title ?? (box.label ? `${formWord[form] ?? "Auto Dev"} \xB7 ${box.label}` : formWord[form] ?? "Auto Dev");
  const line = box.line ?? (CARD_FORM.has(form) || box.title ? "" : String(data.summary ?? ""));
  const rawTag = box.tag ?? "";
  const tag = isPath(rawTag) ? "" : rawTag;
  if (!CARD_FORM.has(form)) {
    return h(
      "div",
      { className: "ad3 ad3-ev-row", "data-tone": tone, title: isPath(rawTag) ? rawTag : void 0 },
      h("span", { className: "ad3-ev-glyph", "aria-hidden": true }, formGlyph[form] ?? "\u25C6"),
      h("span", { className: "ad3-ev-title" }, title),
      line ? h("span", { className: "ad3-ev-line", title: line }, line) : null,
      tag ? h("span", { className: "ad3-ev-tag" }, tag) : null
    );
  }
  const warns = Array.isArray(box.warnings) ? box.warnings.filter(Boolean) : [];
  return h(
    "div",
    { className: "ad3 ad3-ev", "data-tone": tone },
    h(
      "div",
      { className: "ad3-ev-head" },
      h("span", { className: "ad3-ev-dot", "aria-hidden": true }),
      h("span", { className: "ad3-ev-title" }, title),
      h("span", { className: "ad3-ev-spacer" }),
      box.meta ? h("span", { className: "ad3-ev-meta" }, box.meta) : null,
      tag ? h("span", { className: "ad3-ev-tag" }, tag) : null
    ),
    line ? h(
      "div",
      { className: "ad3-ev-body" },
      h("span", { className: "ad3-ev-line", title: line }, line)
    ) : null,
    warns.length ? h(
      "div",
      { className: "ad3-ev-warn", title: warns.join("\n") },
      h("b", { "aria-hidden": true }, "!"),
      h("span", null, warns[0]),
      warns.length > 1 ? h("span", { className: "ad3-ev-more" }, `+${warns.length - 1}`) : null
    ) : null
  );
}
function Seals({ pair }) {
  const before = pair?.before;
  const after = pair?.after;
  return h(
    "span",
    {
      className: "ad3-seals",
      title: `${before?.label ?? "\u5F00\u59CB\u524D"} ${before ? `\u5DF2\u5B58 #${before.seq}` : "\u672A\u5B58"} \xB7 ${after?.label ?? "\u5B8C\u6210\u540E"} ${after ? `\u5DF2\u5B58 #${after.seq}` : "\u672A\u5B58"}`
    },
    h("span", { className: "ad3-seal", "data-on": before ? "true" : "false" }, "\u524D"),
    h("span", { className: "ad3-seal", "data-on": after ? "true" : "false" }, "\u540E")
  );
}
var pairOf = (marks, unitId) => {
  const rows = (Array.isArray(marks) ? marks : []).filter((row2) => row2 && (row2.unit === unitId || row2.boss === unitId));
  if (!rows.length) return void 0;
  const pick = (tag) => [...rows].reverse().find((row2) => row2.tag === tag);
  return { before: pick("before"), after: pick("after") };
};
function packetsOf(units, openOf = () => false, onOpen = () => {
}, delegated = /* @__PURE__ */ new Map(), marks = []) {
  const noteLine = (entry, className, key) => h(
    "div",
    { key, className },
    h("span", { className: "ad3-dot", "aria-hidden": true }),
    h("span", { className: "ad3-note-text", title: entry.text }, entry.text),
    h("span", { className: "ad3-clock", title: entry.at ?? "" }, clockOf(entry.at))
  );
  const ranked = [...units].sort((left, right) => (left.state === "done" ? 1 : 0) - (right.state === "done" ? 1 : 0));
  return h("ol", { className: "ad3-units" }, ranked.map((unit) => {
    const trail = Array.isArray(unit.notes) ? unit.notes : [];
    const used = delegated.get(unit.id) ?? 0;
    const newest = trail.length > 0 ? trail[trail.length - 1] : void 0;
    const live2 = unit.state === "active";
    const older = live2 ? trail.slice(0, -1).reverse() : [];
    const claims = Array.isArray(unit.claims) ? unit.claims.filter((claim) => claim && claim.text) : [];
    const proven = claims.filter((claim) => claim.proven).length;
    const expandable = older.length > 0 || claims.length > 0;
    const open = expandable && openOf(unit.id);
    const toggle = () => onOpen(unit.id);
    return h(
      "li",
      { key: unit.id, className: "ad3-row-wrap", "data-state": unit.state },
      h(
        "div",
        {
          className: `ad3-row${expandable ? " ad3-row-openable" : ""}`,
          "data-state": unit.state,
          // The whole row is the target, not a 10px glyph: a row with a trail is a
          // disclosure (click, or Enter/Space on the keyboard). A row without one
          // stays inert, so nothing looks clickable that would do nothing.
          ...expandable ? {
            role: "button",
            tabIndex: 0,
            "aria-expanded": open ? "true" : "false",
            "aria-label": `${open ? "\u6536\u8D77" : "\u5C55\u5F00"} ${unit.goal} \u7684\u8FDB\u5EA6\uFF08\u5171 ${trail.length} \u6761\uFF09`,
            title: open ? "\u6536\u8D77\u66F4\u65E9\u7684\u8FDB\u5EA6" : `${trail.length} \u6761\u8FDB\u5EA6\uFF0C\u70B9\u5F00\u770B\u66F4\u65E9\u7684`,
            onClick: toggle,
            onKeyDown: (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggle();
              }
            }
          } : {}
        },
        h(
          "div",
          { className: "ad3-row-head" },
          // The running row's triangle is drawn by CSS, not a glyph: U+25B6 and
          // its neighbours live in emoji-capable ranges, and a browser that hands
          // them to the emoji font ignores `color` entirely (it came out blue
          // against a green row). A border triangle is just ink, so it takes the
          // accent like everything else.
          h("span", {
            className: unit.state === "active" ? "ad3-mark ad3-mark-play" : "ad3-mark",
            "aria-hidden": true
          }, unit.state === "active" ? "" : unitMark(unit.state)),
          h(
            "span",
            { className: "ad3-goal-cell" },
            h("span", { className: "ad3-goal-text", title: unit.goal }, unit.goal)
          ),
          // A unit that promised something says so on its own row: the deliverable
          // is what a person would be shown, and the two marks say a before/after
          // pair exists. Neither is a claim about whether it worked.
          unit.deliverable ? h("span", { className: "ad3-deliv", title: `\u80FD\u7ED9\u4EBA\u770B\u7684\uFF1A${unit.deliverable}` }, "\u4EA4\u4ED8") : null,
          pairOf(marks, unit.id) ? h(Seals, { pair: pairOf(marks, unit.id) }) : null,
          unit.asked ? h("span", { className: "ad3-ask", title: unit.asked }, "\u9700\u8981\u4F60") : null,
          // How many lines this packet holds: one glance says whether opening it
          // is worth a click. It sits against the goal, not at the far edge.
          trail.length > 1 ? h("span", { className: "ad3-count", title: `${trail.length} \u6761\u8FDB\u5EA6` }, trail.length) : null,
          claims.length ? h("span", { className: "ad3-proofs", "data-weak": proven < claims.length ? "true" : "false", title: `${claims.length} \u6761\u58F0\u660E\uFF0C${proven} \u6761\u6709\u6267\u884C\u8BC1\u636E` }, `\u5B9E\u6D4B ${proven}/${claims.length}`) : null,
          used ? h("span", { className: "ad3-delegated", title: `\u8FD9\u4E2A packet \u7528\u8FC7 ${used} \u4E2A\u5B50\u4EE3\u7406\uFF1B\u6D3E\u51FA\u3001\u6D3B\u52A8\u548C\u56DE\u62A5\u90FD\u5199\u5728\u4E0B\u65B9\u7684 notes \u91CC` }, `\u5B50\u4EE3\u7406 ${used}`) : null,
          h("span", { className: "ad3-spacer" }),
          // Only the packet that is moving earns a word: five rows all saying 未开始 is noise.
          unit.state === "active" || unit.state === "blocked" ? h("span", { className: "ad3-num" }, unitWord(unit.state)) : null
        ),
        // A unit in flight says what it owes, in its own sentence: the promise is
        // the thing a person would ask about, and a hover title is not a panel.
        unit.deliverable && unit.state === "active" ? h(
          "div",
          { key: "promise", className: "ad3-row-promise", title: unit.deliverable },
          h("span", { className: "ad3-promise-label" }, "\u8981\u4EA4"),
          h("span", { className: "ad3-promise-text" }, unit.deliverable)
        ) : null,
        live2 && newest ? noteLine(newest, "ad3-note-line", "newest") : null
      ),
      open && claims.length ? h("ul", { className: "ad3-claims" }, claims.map((claim, index) => h(
        "li",
        { key: `${unit.id}-claim-${index}`, className: "ad3-claim" },
        h("span", { className: "ad3-proof", "data-proven": claim.proven ? "true" : "false", title: claim.proven ? claim.command ?? "\u6709\u6267\u884C\u8BB0\u5F55" : "\u6CA1\u6709\u6267\u884C\u8BB0\u5F55\uFF0C\u8981\u4EBA\u6309\u6B65\u9AA4\u770B" }, claim.proven ? "\u5B9E\u6D4B" : "\u4EBA\u5DE5"),
        h("span", null, claim.text)
      ))) : null,
      open && older.length ? h("ol", { className: "ad3-notes" }, older.map((entry, index) => h("li", {
        key: `${unit.id}-${index}`,
        className: "ad3-note-wrap"
      }, noteLine(entry, "ad3-note-row", `${unit.id}-${index}-line`)))) : null
    );
  }));
}
function unitList(state, foldOf = () => false, onToggle = () => {
}, openOf = () => false, onOpen = () => {
}, delegated = /* @__PURE__ */ new Map(), marks = []) {
  const groups = state.milestones ?? [];
  const units = state.units ?? [];
  const byId = new Map(groups.map((group) => [group.id, group]));
  const loose = units.filter((unit) => !unit.parent && !byId.has(unit.id));
  const ordered = [...groups.filter((group) => group.role !== "daily"), ...groups.filter((group) => group.role === "daily")];
  const cards = ordered.map((group) => {
    const done = group.units.filter((child) => child.state === "done").length;
    const folded = foldOf(group.id);
    return h(
      "section",
      { key: group.id, className: group.role === "daily" ? "ad3-group ad3-group-daily" : "ad3-group", "data-state": group.state, "data-folded": folded ? "true" : "false" },
      h(
        "button",
        {
          type: "button",
          className: "ad3-group-head",
          "aria-expanded": folded ? "false" : "true",
          title: folded ? "\u5C55\u5F00\u8FD9\u4E00\u6B65" : "\u6536\u8D77\u8FD9\u4E00\u6B65",
          onClick: () => onToggle(group.id)
        },
        // One triangle per card, and it is the caret: a mark glyph beside it made
        // the head read as two controls doing the same thing.
        h("span", { className: "ad3-caret", "data-open": folded ? "false" : "true", "aria-hidden": true }, "\u203A"),
        h("span", { className: "ad3-group-label", title: group.label }, group.label),
        // The theme's own word: a card that closed says so, and does not lean on
        // the count alone to explain why the rows are gone.
        group.role === "daily" ? h("span", { className: "ad3-theme-state", title: "\u65E5\u9700\uFF1A\u6CA1\u5F52\u5230\u6218\u5F79\u4E3B\u9898\u7684\u5C0F\u52A8\u4F5C\u90FD\u653E\u8FD9\u91CC\uFF0C\u5B83\u4E0D\u4F1A\u6536\u675F" }, "\u5C0F\u52A8\u4F5C") : h("span", { className: "ad3-theme-state", "data-state": group.state }, group.state === "done" ? "\u5DF2\u6536" : group.state === "active" ? "\u8FDB\u884C\u4E2D" : ""),
        h("span", { className: "ad3-spacer" }),
        h("span", { className: "ad3-num" }, `${done}/${group.units.length}`)
      ),
      folded ? null : packetsOf(group.units, openOf, onOpen, delegated, marks)
    );
  });
  if (!cards.length) return packetsOf(loose, openOf, onOpen, delegated, marks);
  return h(
    "div",
    { className: "ad3-groups" },
    loose.length ? h("section", { key: "loose", className: "ad3-group ad3-group-loose" }, packetsOf(loose, openOf, onOpen, delegated, marks)) : null,
    cards
  );
}
function basename(path) {
  if (typeof path !== "string" || path === "") return "";
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}
function shortRef(ref) {
  if (typeof ref !== "string") return "";
  const tail = ref.split("/").pop() ?? ref;
  return tail.length > 12 ? `${tail.slice(0, 12)}\u2026` : tail;
}
function row(label, value, options = {}) {
  if (value === null || value === void 0 || value === "") return null;
  return h(
    "div",
    { key: label, className: "ad3-asset" },
    h("span", { className: "ad3-asset-label" }, label),
    h("span", { className: options.mono ? "ad3-asset-value ad3-mono-value" : "ad3-asset-value", title: options.title ?? void 0 }, value)
  );
}
function gateRow(gates) {
  if (!gates || typeof gates !== "object") return null;
  const names = [["evidence", "\u8BC1\u636E"], ["scope", "\u8303\u56F4"], ["authorization", "\u6388\u6743"], ["plan", "\u8BA1\u5212"]];
  const chips = names.map(([key, label]) => h("span", {
    key,
    className: gates[key] ? "ad3-gate on" : "ad3-gate",
    title: gates[key] ? `${label}\u95E8\uFF1A\u8FD9\u6B21\u4EFB\u52A1\u4F1A\u6821\u9A8C` : `${label}\u95E8\uFF1A\u8FD9\u6B21\u8F66\u9053\u4E0D\u6821\u9A8C`
  }, label));
  return h(
    "div",
    { key: "gates", className: "ad3-asset" },
    h("span", { className: "ad3-asset-label" }, "\u6821\u9A8C"),
    h("span", { className: "ad3-gates" }, chips)
  );
}
function factsBody(state) {
  const assets = state.assets ?? {};
  const memory = assets.memory ?? null;
  const checkpoint = assets.checkpoint ?? null;
  const rows = [
    row("\u4ED3\u5E93", state.project, { mono: true }),
    row("\u68C0\u67E5", assets.verifier ?? "\u672A\u63A2\u6D4B\u5230\u68C0\u67E5\u547D\u4EE4", { mono: Boolean(assets.verifier) }),
    gateRow(state.gates),
    memory && (memory.facts || memory.incidents) ? row("\u8BB0\u5FC6", `${memory.facts} \u6761\u4E8B\u5B9E \xB7 ${memory.incidents} \u6761\u6559\u8BAD`, { title: (memory.items ?? []).join("\n") }) : row("\u8BB0\u5FC6", "\u8FD8\u6CA1\u6709\u8BB0\u4F4F\u4EFB\u4F55\u4E1C\u897F"),
    row("\u56DE\u6267", state.hasReceipt ? "\u5DF2\u8BB0\u5F55\uFF08\u4E0D\u4EE3\u8868\u7528\u6237\u5DF2\u786E\u8BA4\uFF09" : "\u672A\u8BB0\u5F55", { title: "\u76EE\u6807 / \u9A8C\u6536 / \u4E0D\u505A / \u5DF2\u63A5\u53D7\u7684\u9ED8\u8BA4\uFF0C\u56DB\u884C\u4E00\u5C4F" }),
    state.goalRevision > 1 ? row("\u76EE\u6807", `\u7B2C ${state.goalRevision} \u7248 \xB7 ${state.goalHistory.join(" / ")}`, { title: "\u65E7\u7684\u8BF4\u6CD5\uFF0C\u6309\u65F6\u95F4\u5012\u5E8F" }) : row("\u76EE\u6807", "\u7B2C 1 \u7248\uFF08\u6CA1\u6539\u8FC7\uFF09"),
    row("\u6F84\u6E05", state.clarify ? `${state.clarify.asked} \u95EE \xB7 ${state.clarify.answered} \u7B54${state.clarify.waiting === "user-answer" ? " \xB7 \u7B49\u5F85\u56DE\u7B54" : state.clarify.waiting === "user-choice" ? " \xB7 \u7B49\u5F85\u9009\u62E9" : state.clarify.assumption ? " \xB7 \u7528\u4E86\u9ED8\u8BA4" : ""}` : "\u672A\u8BB0\u5F55\u6F84\u6E05", { title: state.clarify?.pending?.length ? state.clarify.pending.join("\uFF1B") : state.clarify?.assumption ?? "\u6CA1\u6709\u6F84\u6E05\u8BB0\u5F55\u4E0D\u4EE3\u8868\u9700\u6C42\u5DF2\u786E\u8BA4" }),
    checkpoint && checkpoint.count ? row("\u5B58\u6863", `${checkpoint.count} \u4E2A \xB7 ${shortRef(checkpoint.ref)}`, { mono: true, title: checkpoint.ref ?? "" }) : row("\u5B58\u6863", "\u672C\u6B21\u6CA1\u6709\u5FEB\u7167")
  ].filter(Boolean);
  return h("div", { className: "ad3-facts-body" }, rows);
}
function Goal({ text }) {
  const [open, setOpen] = (0, import_react.useState)(false);
  const long = typeof text === "string" && text.length > 120;
  const clamped = long && !open;
  return h(
    "div",
    { className: "ad3-goal-wrap" },
    h("h2", { className: `ad3-goal${clamped ? " is-clamped" : ""}`, title: long ? text : void 0 }, text),
    long ? h("button", {
      type: "button",
      className: "ad3-goal-more",
      "aria-expanded": open ? "true" : "false",
      onClick: () => setOpen((value) => !value)
    }, open ? "\u6536\u8D77\u76EE\u6807" : "\u5C55\u5F00\u76EE\u6807") : null
  );
}
function delegatedUnits(state) {
  const counts = /* @__PURE__ */ new Map();
  for (const child of Array.isArray(state.children) ? state.children : []) {
    if (child && typeof child.unit === "string" && child.unit !== "") {
      counts.set(child.unit, (counts.get(child.unit) ?? 0) + 1);
    }
  }
  return counts;
}
var TASK_WORD = { active: "\u8FDB\u884C\u4E2D", paused: "\u6682\u505C", review_ready: "\u7B49\u4F60\u7528\u8FC7", closed: "\u5DF2\u6536\u675F", cancelled: "\u5DF2\u53D6\u6D88" };
var taskWord = (state) => TASK_WORD[state] ?? (typeof state === "string" ? state : "");
function shortDate(value) {
  if (typeof value !== "string" || value.length < 16) return "";
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}
function Timeline({ rows, openOf, onOpen }) {
  const list = Array.isArray(rows) ? rows.filter((row2) => row2 && typeof row2.id === "string") : [];
  if (list.length < 2) return null;
  return h(
    "div",
    { className: "ad3-section ad3-timeline" },
    h(
      "div",
      { className: "ad3-section-head" },
      h("span", { className: "ad3-eyebrow" }, "\u65F6\u95F4\u7EBF"),
      h("span", { className: "ad3-note ad3-inline-note" }, `${list.length} \u4E2A\u4EFB\u52A1`)
    ),
    h("ul", { className: "ad3-tl" }, list.map((row2) => {
      const open = openOf(row2.id);
      const units = Array.isArray(row2.units) ? row2.units : [];
      const meta = [taskWord(row2.state), row2.themes ? `${row2.themes} \u4E3B\u9898` : "", row2.marks ? `${row2.marks} \u5B58\u6863` : ""].filter(Boolean).join(" \xB7 ");
      return h(
        "li",
        {
          key: row2.id,
          className: "ad3-tl-item",
          "data-current": row2.current ? "true" : void 0,
          "data-state": row2.state ?? void 0
        },
        h(
          "button",
          {
            type: "button",
            className: "ad3-tl-head",
            "aria-expanded": open ? "true" : "false",
            title: row2.goal || row2.id,
            onClick: () => onOpen(row2.id)
          },
          h("span", { className: "ad3-tl-when" }, shortDate(row2.at)),
          h("span", { className: "ad3-tl-dot", "aria-hidden": "true" }),
          h("span", { className: "ad3-tl-goal" }, row2.goal || "\uFF08\u672A\u5199\u76EE\u6807\uFF09"),
          row2.current ? h("span", { className: "ad3-tl-now" }, "\u5F53\u524D") : null,
          h("span", { className: "ad3-spacer" }),
          h("span", { className: "ad3-tl-meta" }, meta),
          h("span", { className: "ad3-caret", "data-open": open ? "true" : void 0 }, "\u203A")
        ),
        open && units.length ? h("ul", { className: "ad3-tl-units" }, units.map((unit) => h(
          "li",
          {
            key: unit.id,
            className: "ad3-tl-unit",
            "data-state": unit.state
          },
          h("span", { className: "ad3-mark" }, unitMark(unit.state)),
          h("span", { className: "ad3-tl-unit-goal" }, unit.goal),
          unit.parent ? h("span", { className: "ad3-tl-parent" }, unit.parent) : null
        ))) : null
      );
    }))
  );
}
function Board({ useProjection }) {
  const state = useProjection("dshAutoDev");
  const [folded, setFolded] = import_react.default.useState({});
  const [opened, setOpened] = import_react.default.useState({});
  if (!state) {
    return h(
      "section",
      { className: "ad3 ad3-pane", "aria-label": "Auto Dev \u770B\u677F" },
      h("style", null, css),
      h(
        "div",
        { className: "ad3-empty" },
        h("span", { className: "ad3-eyebrow" }, "Auto Dev"),
        h("p", { className: "ad3-note" }, "\u5F00\u59CB\u4EFB\u52A1\u540E\uFF0C\u8FD9\u91CC\u663E\u793A\u76EE\u6807\u3001\u5206\u6B65\u4E0E\u6BCF\u4E00\u6B21\u4EA4\u4ED8\u3002")
      )
    );
  }
  const last = state.last;
  const counting = state.counting ?? {};
  const done = counting.done ?? 0;
  const total = counting.total ?? 0;
  const foldOf = (id) => {
    if (folded[id] !== void 0) return folded[id];
    const group = (state.milestones ?? []).find((row2) => row2.id === id);
    return group?.role === "daily" ? true : group?.state === "done";
  };
  const onToggle = (id) => setFolded((previous) => ({ ...previous, [id]: !(previous[id] === void 0 ? (state.milestones ?? []).find((group) => group.id === id)?.state === "done" : previous[id]) }));
  const campaigns = (state.milestones ?? []).filter((group) => group.role !== "daily");
  const milestoneDone = campaigns.filter((group) => group.state === "done").length;
  return h(
    "section",
    { className: "ad3 ad3-pane", "aria-label": "Auto Dev \u770B\u677F" },
    h("style", null, css),
    // Title first, facts under it: a pane is read top-down, and the eyebrow that
    // names the lane belongs above the thing it describes, not beside a rule.
    h(
      "div",
      { className: "ad3-head" },
      h(
        "div",
        { className: "ad3-head-top" },
        h("span", { className: "ad3-eyebrow" }, laneWord(state)),
        h("span", { className: "ad3-spacer" }),
        h(State, { state })
      ),
      h(Goal, { text: state.goal || state.request || "\uFF08\u672A\u5199\u76EE\u6807\uFF09" }),
      // A goal that was revised is not a mistake to hide: the number says how many
      // times the person's mind changed, and the old sentences stay in the record.
      (state.goalRevision ?? 0) > 1 ? h("p", { className: "ad3-under" }, `\u7B2C ${state.goalRevision} \u7248 \xB7 \u4E4B\u524D\u7684\u76EE\u6807\u7559\u5728\u5DE5\u7A0B\u8BB0\u5F55\u91CC`) : null,
      // The program is a bigger intention than the task; when they differ, say so
      // once, quietly, instead of stacking a second heading under the first.
      state.program && state.program !== (state.goal || state.request) ? h("p", { className: "ad3-under" }, state.program) : null,
      h(
        "div",
        { className: "ad3-meta" },
        h(Rail, { done, total, pending: 0, label: counting.label }),
        state.project ? h("span", { className: "ad3-num", title: state.project }, basename(state.project)) : null,
        // Old tasks carry checkpoints written before a checkpoint belonged to a
        // unit; without this line their archives were invisible everywhere.
        (state.checkpoints ?? 0) > 0 ? h("span", { className: "ad3-num", title: "\u672C\u4EFB\u52A1\u5B58\u8FC7\u7684\u5B58\u6863\u6570" }, `\u5B58\u6863 ${state.checkpoints}`) : null,
        state.acceptanceMode ? h("span", { className: "ad3-num", title: state.acceptanceMode === "pm" ? "\u5B8C\u6210\u540E\u7B49\u5F85\u4F60\u7684\u5B9E\u9645\u9A8C\u6536" : "\u5B8C\u6210\u7531\u9879\u76EE\u81EA\u5DF1\u7684\u68C0\u67E5\u5224\u5B9A" }, state.acceptanceMode === "pm" ? "\u7531\u4F60\u9A8C\u6536" : "\u81EA\u52A8\u6536") : null,
        // Reminders read in the last delivery below, in their own words; a count
        // here as well was the same fact twice.
        state.warnings && warningLines(state).length && !state.last ? h("span", { className: "ad3-num ad3-warn", title: warningLines(state).join("\n") }, warningsLabel(state.warnings)) : null
      )
    ),
    h(
      "details",
      { className: "ad3-facts" },
      h("summary", null, `\u9A8C\u6536\u6761\u4EF6\u4E0E\u672A\u9A8C\u8BC1\u9879${state.unverified?.length ? ` \xB7 ${state.unverified.length} \u9879` : ""}`),
      h(
        "div",
        { className: "ad3-facts-body" },
        row("\u9A8C\u6536\u6761\u4EF6", state.acceptance?.length ? state.acceptance.join("\uFF1B") : "\u672A\u8BB0\u5F55\u9A8C\u6536\u6761\u4EF6"),
        row("\u672A\u9A8C\u8BC1\u9879", state.unverified?.length ? state.unverified.join("\uFF1B") : "\u672C\u6B21\u672A\u62A5\u544A\u672A\u9A8C\u8BC1\u9879")
      )
    ),
    state.units?.length ? h(
      "div",
      { className: "ad3-section" },
      h(
        "div",
        { className: "ad3-section-head" },
        h("span", { className: "ad3-eyebrow" }, "\u5206\u6B65"),
        campaigns.length ? h("span", { className: "ad3-note ad3-inline-note" }, `${campaigns.length} \u4E2A\u4E3B\u9898${milestoneDone ? ` \xB7 ${milestoneDone} \u5DF2\u6536` : ""}`) : (state.units?.length ?? 0) > 5 ? h("span", { className: "ad3-note ad3-inline-note ad3-ungrouped", title: "\u8FD9\u4E2A\u8BA1\u5212\u6CA1\u6709\u5206\u7EC4\uFF1A\u5982\u679C\u5176\u4E2D\u6709\u4E24\u6761\u4EE5\u4E0A\u72EC\u7ACB\u7684\u9A8C\u6536\u76EE\u6807\uFF0C\u53EF\u4EE5\u7ED9\u5B83\u4EEC\u7ACB\u4E00\u4E2A theme" }, "\u672A\u5206\u7EC4") : null
      ),
      unitList(
        state,
        foldOf,
        onToggle,
        (id) => opened[id] === true,
        (id) => setOpened((previous) => ({ ...previous, [id]: !previous[id] })),
        delegatedUnits(state),
        state.marks ?? []
      )
    ) : null,
    last ? h(
      "div",
      { className: "ad3-last" },
      h(
        "div",
        { className: "ad3-last-line" },
        h("span", { className: "ad3-eyebrow" }, last.unit ? `\u6700\u8FD1\u4E00\u6B21\u7ED3\u8D26 \xB7 ${last.unit}` : "\u6700\u8FD1\u4E00\u6B21\u7ED3\u8D26\uFF08\u4EFB\u52A1\u7EA7\uFF09"),
        h("span", { style: { flex: 1 } }),
        h("span", { className: "ad3-outcome", "data-outcome": last.outcome ?? "" }, outcomeWord(last.outcome))
      ),
      last.summary ? h("p", { className: "ad3-summary" }, last.summary) : null,
      warningLines(state).length ? h("p", { className: "ad3-last-warn", title: warningLines(state).join("\n") }, h("b", { "aria-hidden": true }, "!"), h("span", null, warningLines(state)[0]), warningLines(state).length > 1 ? h("span", { className: "ad3-ev-more" }, `+${warningLines(state).length - 1}`) : null) : null,
      last.residue?.length ? h("p", { className: "ad3-note" }, `\u672A\u5B8C\u6210 \xB7 ${last.residue.join("\u3001")}`) : null,
      live(state) && cleanNext(state.next) ? h("p", { className: "ad3-note" }, `\u63A5\u4E0B\u6765 \xB7 ${cleanNext(state.next)}`) : null
    ) : null,
    // The project's history belongs under the current task, not above it: what is
    // moving now is what the owner opens the panel for, and a stack of past tasks
    // on top pushes the running themes below the fold.
    h(Timeline, {
      rows: state.timeline,
      openOf: (id) => opened[`tl:${id}`] === true,
      onOpen: (id) => setOpened((previous) => ({ ...previous, [`tl:${id}`]: !previous[`tl:${id}`] }))
    }),
    h(
      "details",
      { className: "ad3-facts" },
      h("summary", null, "\u5DE5\u7A0B\u8BB0\u5F55"),
      factsBody(state)
    )
  );
}
var inject = ["slots", "sidebarRight", "sidebarRightTabs", "uiConversation"];
function apply(ctx) {
  const tabId = "dsh-auto-dev/board";
  const kind = "dsh-auto-dev-board";
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: tabId,
    kind,
    title: () => "Auto Dev",
    guide: [{ id: "board", order: 20, title: () => "Auto Dev", description: () => "\u4EFB\u52A1\u3001\u5206\u6B65\u4E0E\u6700\u8FD1\u4E00\u6B21\u4EA4\u4ED8" }]
  }), "dsh-auto-dev board tab");
  ctx.effect(() => ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    id: "dsh-auto-dev-dock",
    order: -18,
    inject: () => ({ openBoard: () => ctx.sidebarRight.openTab(kind) })
  }, Bar)), "dsh-auto-dev dock bar");
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: tabId
  }, Board)), "dsh-auto-dev board body");
  let releaseCards = null;
  try {
    const unview = ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
      name: "conversation.chat.node",
      key: "auto-dev-event"
    }, StreamCard));
    const unclaim = ctx.uiConversation.events.register({
      kind: "auto-dev-event",
      target: "chat",
      match: (event) => {
        if (event?.type !== "user/message") return null;
        const source = event.data?.source;
        if (!source || source.kind !== "dsh-auto-dev") return null;
        if (!source.form || source.form === "notice") return null;
        return { id: String(event.data.id ?? event.seq), role: "start", exclusive: true };
      },
      start: (_context, match) => {
        const event = match.event;
        const source = event?.data?.source ?? {};
        const text = Array.isArray(event?.data?.content) ? event.data.content.find((item) => item?.type === "text")?.text ?? "" : "";
        return { seq: event.seq, time: event.time, form: source.form, data: source.data ?? null, text, summary: source.summary ?? "" };
      },
      update: (context) => context.state,
      // Never null: a node that exists but cannot be built still has to reach the
      // screen, or the claim above has hidden it for good.
      buildViewNode: (context) => {
        const state = context.state;
        const claimed = context.start?.event;
        const source = claimed?.data?.source;
        const seq = state?.seq ?? claimed?.seq ?? 0;
        const { seq: _seq, ...data } = state ?? {
          form: source?.form ?? null,
          data: source?.data ?? null,
          text: "",
          summary: source?.summary ?? ""
        };
        return {
          key: context.key,
          kind: "auto-dev-event",
          id: context.id,
          target: "chat",
          anchorSeq: seq,
          location: context.start?.location ?? { kind: "unresolved" },
          visibility: "visible",
          // Outside the Turn's process group. A task being worked on has to stay
          // watchable while it runs; folded into the process it is invisible until
          // somebody opens the group, which is the same as not reporting at all.
          groupTree: "exchange",
          data
        };
      }
    });
    releaseCards = () => {
      if (typeof unclaim === "function") unclaim();
      if (typeof unview === "function") unview();
    };
    ctx.effect(() => releaseCards, "dsh-auto-dev stream cards");
  } catch (error) {
    if (typeof releaseCards === "function") releaseCards();
    releaseCards = null;
    console.warn("dsh-auto-dev: stream cards unavailable on this build; status events stay as plain rows", error);
  }
}
return module.exports;}});
