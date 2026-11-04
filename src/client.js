/**
 * dsh-auto-dev — client half.
 *
 * One bar above the composer and one sidebar tab, both drawn from the
 * `dshAutoDev` session projection.
 *
 * Visual language: Swiss restraint on the host's own tokens. Hairline rules
 * instead of boxes, one accent (the host's business blue) used for progress,
 * completion and the composer dock's outline and tint, uppercase micro-labels
 * at 11px with open tracking, a 12-15px reading scale, tabular numerals for
 * every count, and 160ms state
 * transitions — plus one 1.8s breath reserved for the unit in flight. Every
 * label on the bar carries its evidence in a hover card: the bar stays quiet,
 * and the sentence behind each mark is one pointer move away. Nothing here
 * invents a second palette, so light and dark both follow the host.
 *
 * No custom settings UI: the host's settings dialog already owns those controls.
 */
import React, { useRef, useState } from 'react'
import { modeLabel } from './mode.mjs'

const h = React.createElement

// What the model declared (look / do) is not shown as a fact about the task (v55: 「只读意图」 on a task that wrote files).
const laneWord = () => '任务'
const outcomeWord = outcome => ({ complete: '已达成', partial: '部分完成', blocked: '受阻', failed: '未达成' }[outcome] ?? '进行中')

const EMPTY_NEXT = new Set(['', 'none', '无', 'n/a', 'na', '-'])
const cleanNext = value => (typeof value === 'string' && !EMPTY_NEXT.has(value.trim().toLowerCase()) ? value.trim() : '')
/**
 * The state the bar should draw, read from the plan rather than trusted blindly.
 * A nested plan never marks its milestone rows done, so a finished task came back
 * as "进行中 3/3"; the leaves are what a milestone means.
 */
const settledState = state => {
  if (state.taskState === 'cancelled' || state.taskState === 'paused' || state.taskState === 'review_ready') return state.taskState
  const units = state.units ?? []
  const leaves = units.filter(unit => !units.some(candidate => candidate.parent === unit.id))
  return leaves.length > 0 && leaves.every(unit => unit.state === 'done') ? 'closed' : state.taskState
}
const pillOf = state => {
  const settled = settledState(state)
  if (settled === 'cancelled') return ['已取消', 'danger']
  if (settled === 'paused') return ['已暂停', 'warning']
  if (settled === 'review_ready') return ['等你用过', 'warning']
  if (settled === 'closed') return ['已收', 'muted']
  return ['进行中', 'accent']
}

// A task that can still move owns the "running" surfaces; a closed or cancelled
// one keeps its record but has no next step to draw.
const live = state => ['active', 'paused'].includes(settledState(state))

const clamp = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)
const headline = state => settledState(state) === 'closed' && state.last
  ? `上一次交付：${outcomeWord(state.last.outcome)}${state.last.summary ? ` · ${clamp(state.last.summary, 52)}` : ''}`
  // Waiting on the person, the model's own "next" is moot ("无；三项单元全部完成"):
  // the line names what was delivered.
  : settledState(state) === 'review_ready'
    ? clamp(state.goal || state.request || cleanNext(state.next) || '', 72)
    : clamp(cleanNext(state.next) || state.goal || state.request || '', 72)

// Every glyph here has to be text-presentation: U+25B6 (▶) is emoji-capable, and
// browsers hand it to the emoji font, which ignores `color` — the row's mark came
// out blue no matter what the stylesheet said. U+25B8 is the same shape without an
// emoji rendering, so it takes the accent like the check does.
const unitMark = state => state === 'done' ? '✓' : state === 'active' ? '▸' : state === 'blocked' ? '!' : '○'
const unitWord = state => ({ done: '已完成', active: '进行中', blocked: '受阻' }[state] ?? '未开始')

/** A note carries an ISO stamp; the trail shows the clock, nothing else. */
function clockOf(at) {
  if (typeof at !== 'string' || at === '') return ''
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
}
/** How long the unit in flight has run, in the unit a person would say it in. */
function elapsedWord(since, now = Date.now()) {
  const start = typeof since === 'number' ? since : typeof since === 'string' ? new Date(since).getTime() : NaN
  if (Number.isNaN(start)) return ''
  const minutes = Math.max(0, Math.round((now - start) / 60000))
  return minutes < 1 ? '刚开始' : minutes < 60 ? `${minutes} 分` : `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`
}
// The person's words for the last delivery's doubts; older boards only have the model's.
const warningLines = state => (Array.isArray(state.reminders) ? state.reminders
  : Array.isArray(state.warningLines) ? state.warningLines : [])
const warningsLabel = n => `${n} 条提醒`

const css = `
.ad3{--ad3-bg:var(--dsw-alias-bg-base,var(--background-primary,#f7f8fa));--ad3-surface:var(--dsw-specific-tip,var(--background-secondary,#fff));--ad3-border:var(--dsw-alias-border-l1,var(--border-color,#d9dde3));--ad3-border-strong:var(--dsw-alias-border-l3,#c6ccd4);--ad3-text:var(--dsw-alias-label-primary,var(--text-primary,#20242a));--ad3-muted:var(--dsw-alias-label-secondary,var(--text-secondary,#61666b));--ad3-caption:var(--dsw-alias-label-tertiary,#81858c);--ad3-accent:#3d7f68;--ad3-warning:var(--dsw-alias-state-warning-primary,#b27a31);--ad3-danger:var(--dsw-alias-state-error-primary,#b54a43);--ad3-hover:var(--dsw-alias-interactive-bg-hover,#0000000d);--ad3-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--ad3-blue:var(--dsw-alias-state-business-primary,#4d6bfe);--ad3-blue-soft:color-mix(in srgb,var(--ad3-blue) 12%,var(--dsw-specific-menu,var(--ad3-surface)));--ad3-blue-line:color-mix(in srgb,var(--ad3-blue) 55%,transparent);--ad3-ring:0 0 0 1px var(--ad3-blue-line);box-sizing:border-box;color:var(--ad3-text);font-size:13px;line-height:20px;font-family:inherit;color-scheme:light dark;-webkit-font-smoothing:antialiased}
/* The composer bar is the Goal dock's sibling: same width formula, same 36px
   height, same panel stroke/radius. Only the tint differs — the host's business
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
/* One packet is a short stack: the goal line, its newest progress line, and —
   only when opened — the older lines. Every line shares one left edge for the
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
   height, so a card reads as a short stack instead of a ragged column — and the
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
   light (7–8%) so ten method hints still never outweigh one delivery. */
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
.ad3-pane .ad3-meta{gap:0;row-gap:2px;flex-wrap:wrap;color:var(--ad3-caption);font-size:11.5px}
.ad3-pane .ad3-meta>span+span::before{content:'·';margin:0 8px;color:var(--ad3-border-strong)}
.ad3-req{display:flex;flex-direction:column;gap:6px;padding:12px 14px 12px 16px;border-radius:12px;background:color-mix(in srgb,var(--ad3-blue) 7%,transparent);box-shadow:inset 3px 0 0 var(--ad3-blue-line)}
.ad3-req ol,.ad3-req ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;color:var(--ad3-text);font-size:12.5px;line-height:19px}
.ad3-req li{overflow-wrap:anywhere}
.ad3-req-miss{display:flex;flex-direction:column;gap:6px;margin-top:4px;padding-top:8px;border-top:.5px solid color-mix(in srgb,var(--ad3-warning) 30%,transparent)}
.ad3-req-miss li{color:var(--ad3-warning)}
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
.ad3-facts>summary::before{content:'›';display:inline-block;width:10px;font-size:14px;color:var(--ad3-caption);transition:transform .12s ease}
.ad3-facts[open]>summary::before{transform:rotate(90deg)}
@media(max-width:560px){.ad3-brand,.ad3-rail>i{display:none}.ad3-state{font-size:12px}}
`

function Icon({ name }) {
  const paths = {
    task: 'M5 3h8v11H3V3h2m1-1h4v3H6V2m0 6h4m-4 3h4',
    archive: 'M2.5 3.5h11v3h-11v-3Zm1 3h9v6h-9v-6Zm3 2.5h3',
    alert: 'M8 2.5 14.5 13.5h-13L8 2.5Zm0 3.6v3.4m0 2.1h.01',
  }
  return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: paths[name] }))
}

/**
 * One mark, one hover card. The card is fixed-positioned so the dock's
 * `overflow:hidden` cannot clip it, and it flips below the anchor only when
 * there is no room above — the bar sits at the bottom of the conversation.
 */
function Tip({ detail, className = '', children }) {
  const [at, setAt] = useState(null)
  const ref = useRef(null)
  const show = () => {
    if (!detail) return
    const node = ref.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const half = 168
    const x = Math.min(Math.max(rect.left + rect.width / 2, half + 10), window.innerWidth - half - 10)
    const above = rect.top > 140
    setAt({ x, y: above ? rect.top - 8 : rect.bottom + 8, above })
  }
  const hide = () => setAt(null)
  return h('span', {
    ref,
    className: `ad3-tip-anchor ${className}`,
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
    onKeyDown: event => { if (event.key === 'Escape') hide() },
  },
  children,
  at ? h('span', {
    className: `ad3-tip${at.above ? '' : ' below'}`,
    role: 'tooltip',
    style: { left: `${at.x}px`, top: `${at.y}px` },
  },
  detail.title ? h('span', { className: 'ad3-tip-title' }, detail.title) : null,
  (detail.lines ?? []).filter(Boolean).map((line, index) => h('span', { key: index, className: 'ad3-tip-line' }, line))) : null)
}

/** A determinate rail: no percentage when the plan is still being unfolded. */
function Rail({ done, total, pending, label }) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0
  // A plan with no committed packets has nothing to fill; it still has a word
  // for the state, and dropping it would read as "this task has no plan".
  if (total <= 0 && pending <= 0) return label ? h('span', { className: 'ad3-num' }, label) : null
  return h('span', { className: 'ad3-rail' },
    total > 0 ? h('i', { role: 'img', 'aria-label': `进度 ${done}/${total}` }, h('b', { style: { width: `${Math.round(ratio * 100)}%` } })) : null,
    total > 0 ? h('span', { className: 'ad3-num' }, `${done}/${total}`) : null,
    pending > 0 ? h('span', { className: 'ad3-pending' }, pending && total <= 0 ? `${pending} 个里程碑待展开` : `+${pending} 待展开`) : null)
}

function State({ state }) {
  const [word, tone] = pillOf(state)
  return h('span', { className: `ad3-state ${tone}`, role: 'status' }, h('i', null), word)
}

function Bar({ useProjection, openBoard }) {
  const state = useProjection('dshAutoDev')
  if (!state) return null
  const where = headline(state)
  const counting = state.counting ?? {}
  const done = counting.done ?? 0
  const total = counting.total ?? 0
  const units = state.units ?? []
  const active = units.find(unit => unit.state === 'active')
  const next = units.find(unit => unit.state === 'pending')
  const warns = warningLines(state)
  const checkpoint = state.assets?.checkpoint?.ref
  // Campaign themes only: the bucket is not a theme, and the dock must not count
  // it as one ("主题 1/2", never "1/3").
  const themes = (state.milestones ?? []).filter(group => group.role !== 'daily')
  const themesDone = themes.filter(group => group.state === 'done').length
  const [word] = pillOf(state)
  const rail = h(Rail, { done, total, pending: state.pendingMilestones ?? 0, label: counting.label })
  // Only a running task has a pulse; a closed one's last check is history.
  const pulse = live(state) && state.pulse?.unit ? state.pulse : null
  const flag = (label, icon, cls) => h('button', {
    type: 'button',
    className: `ad3-flag${cls ? ` ${cls}` : ''}`,
    'aria-label': label,
    onClick: openBoard,
  }, h(Icon, { name: icon }))
  return h('section', { className: 'ad3 ad3-dock', 'aria-label': 'Auto Dev 任务' },
    h('style', null, css),
    h('div', { className: 'ad3-bar' },
      h(Tip, {
        className: 'ad3-tip-grow',
        detail: {
          title: `${laneWord(state)} · ${word}`,
          lines: [
            state.goal || state.request || '',
            state.next && state.next !== state.goal ? `下一步 · ${state.next}` : '',
            state.project ? `项目 · ${state.project}` : '',
          ],
        },
      }, h('button', { type: 'button', className: 'ad3-toggle', onClick: openBoard, 'aria-label': '打开 Auto Dev 看板' },
        h(Icon, { name: 'task' }),
        h('span', { className: 'ad3-brand' }, state.auto ? 'Auto Dev · 自动驾驶' : 'Auto Dev'),
        h('span', { className: 'ad3-where' }, where || '尚未开始'))),
      h('div', { className: 'ad3-actions' },
        pulse ? h(Tip, {
          detail: {
            title: `${stepOf(state, pulse.unit)} · ${elapsedWord(pulse.since)}`,
            lines: [
              pulse.check ? `最近一次检查 · ${pulse.check.command} · ${pulse.check.ok ? '通过' : '没通过'}` : '还没跑过检查',
              pulse.check && pulse.check.count > 1 ? `这条命令已经跑了 ${pulse.check.count} 次` : '',
            ],
          },
        }, h('span', { className: 'ad3-pulse', 'data-ok': pulse.check ? String(Boolean(pulse.check.ok)) : undefined },
          h('b', null, stepOf(state, pulse.unit)),
          h('span', null, elapsedWord(pulse.since)),
          pulse.check ? h('code', null, pulse.check.command) : null,
          pulse.check ? h('i', null, pulse.check.ok ? '✓' : '✕') : null,
          pulse.check && pulse.check.count > 1 ? h('em', null, `第 ${pulse.check.count} 次`) : null)) : null,
        // One theme is the task itself; a count of one says nothing.
        themes.length > 1 ? h(Tip, {
          detail: {
            title: `主题 ${themesDone}/${themes.length}`,
            lines: themes.map(group => `${group.state === 'done' ? '已收' : group.state === 'active' ? '进行中' : '未开始'} · ${group.label}`),
          },
        }, h('span', { className: 'ad3-chip' }, `主题 ${themesDone}/${themes.length}`)) : null,
        rail ? h(Tip, {
          detail: {
            title: total > 0 ? `进度 ${done}/${total}` : (counting.label || '计划'),
            lines: [
              total > 0 ? `已完成 ${done} 个 packet，共 ${total} 个。` : '这份计划还没有 packet。',
              active ? `正在做 ${active.id} · ${active.goal}` : next ? `下一个 ${next.id} · ${next.goal}` : '',
              active?.note ? `最新 · ${active.note}` : '',
            ],
          },
        }, rail) : null,
        state.checkpoints ? h(Tip, {
          detail: {
            title: `存档点 ${state.checkpoints} 个`,
            lines: [
              checkpoint ? `最近一次 · ${checkpoint}` : '宿主还没有记录快照引用。',
              '每个存档点都是改动前后的快照，可以在看板里回滚。',
            ],
          },
        }, flag(`存档点 ${state.checkpoints} 个`, 'archive')) : null,
        state.warnings && warns.length ? h(Tip, {
          detail: {
            title: warningsLabel(state.warnings),
            lines: [...warns.slice(0, 6), warns.length > 6 ? `还有 ${warns.length - 6} 条…` : ''],
          },
        }, flag(warningsLabel(state.warnings), 'alert', 'alert')) : null,
        h(Tip, {
          detail: {
            title: `${laneWord(state)} · ${word}`,
            lines: settledState(state) === 'active'
              ? ['任务进行中：新的 note、提交和存档点会继续写进账本。', total > 0 ? `进度 ${done}/${total}。` : '']
              : settledState(state) === 'paused'
                ? ['任务已暂停，账本和看板都保留。', '用 /dsh-auto-dev resume 恢复。']
                : settledState(state) === 'cancelled'
                  ? ['任务已取消：之后的 work_submit 会被拒绝。', '记录和证据仍保留；要继续请新开任务。']
                  : [state.last ? `最后一次结果：${outcomeWord(state.last.outcome)}。` : '任务已结束。', state.last?.summary ?? ''],
          },
        }, h(State, { state })))))
}

/**
 * Units as the plan really is: a milestone keeps its units under it, indented, so
 * a twenty-unit project does not read as one flat wall. A flat plan renders as a
 * plain list, which is what it is.
 */
// A milestone is a container, not a row: its packets live inside it, and a plan
// with three milestones reads as three cards rather than one long indent.
const CARD_FORM = new Set(['unit-start', 'unit-done', 'unit-blocked', 'ask', 'task-done', 'alternative', 'review'])
const formGlyph = {
  'unit-start': '◇', 'unit-open': '◇', 'unit-done': '◆', 'unit-blocked': '✕', ask: '◌', 'task-done': '✓',
  save: '⤓', 'theme-open': '◻', 'theme-seal': '◼', handoff: '⤓',
  postmortem: '↺', remember: '✎', review: '☑', 'review-done': '☑', 'review-revise': '↺', halt: '⏸', 'organize-done': '⌗',
  'read-doc': '▤', 'verify-start': '▷', env: '⌂', 'env-forget': '⌫', 'organize-proposed': '⌗', 'blocked-call': '⊘',
}
const formWord = {
  'unit-start': '开始', 'unit-open': '开始', 'unit-done': '完成', 'unit-blocked': '没通过', ask: '等你回答', 'task-done': '任务完成',
  save: '存档', 'theme-open': '新主题', 'theme-seal': '主题完成', handoff: '接手',
  postmortem: '复盘', remember: '记住', review: '做完了', 'review-done': '已收案', 'review-revise': '按意见改', halt: '停一下', 'organize-done': '已整理',
  'read-doc': '方法提示', 'verify-start': '待验证', env: '记下环境', 'env-forget': '环境更新', 'organize-proposed': '整理提案', 'blocked-call': '拦下',
}
// The tone a receipt is drawn in. Forms that carry no tone of their own fall
// back by what they mean, so a new form never paints itself green by accident.
const TONE_OF = {
  'unit-blocked': 'blocked', ask: 'ask', alternative: 'ask', review: 'ask', postmortem: 'ask', 'organize-proposed': 'ask',
  'blocked-call': 'guard', 'read-doc': 'neutral', 'verify-start': 'neutral', 'ui-plan': 'neutral',
}
// A file path says where the rule lives, not what it says: it goes on hover.
const isPath = text => /\.(md|mjs|js|json)$/.test(text)

/**
 * One Auto Dev event, as the conversation draws it.
 *
 * The two shapes are deliberate. A unit starting, landing, failing, or stopping to
 * ask a person is a two-line card: title on the first line, the sentence and the
 * next step on the second. Bookkeeping — a theme opening or closing, a hand-off —
 * is one quiet row, because it explains itself and should not compete with the
 * work. The words are the fixed eight; the second line is always the task's own
 * record, never a metaphor of ours.
 */
// Cards in the conversation can mount with no dock or board on screen (a finished
// session opened again, v35): they carry the stylesheet themselves, once per page.
function ensureCss() {
  if (typeof document === 'undefined' || document.getElementById('ad3-css')) return
  const style = document.createElement('style')
  style.id = 'ad3-css'
  style.textContent = css
  document.head.appendChild(style)
}

function StreamCard({ node }) {
  ensureCss()
  const data = node?.data ?? {}
  const form = data.form
  const box = data.data ?? {}
  const tone = box.tone ?? TONE_OF[form] ?? form ?? 'neutral'
  const title = box.title ?? (box.label ? `${formWord[form] ?? 'Auto Dev'} · ${box.label}` : formWord[form] ?? 'Auto Dev')
  // The fallback used to be the model-facing text; that is how a machine sentence
  // ends up in front of a person when a form forgets `line`. Empty is better —
  // except for a form this build has never heard of, where the summary is the only
  // thing that says what happened at all.
  const line = box.line ?? (CARD_FORM.has(form) || box.title ? '' : String(data.summary ?? ''))
  const rawTag = box.tag ?? ''
  const tag = isPath(rawTag) ? '' : rawTag
  if (!CARD_FORM.has(form)) {
    return h('div', { className: 'ad3 ad3-ev-row', 'data-tone': tone, title: isPath(rawTag) ? rawTag : undefined },
      h('span', { className: 'ad3-ev-glyph', 'aria-hidden': true }, formGlyph[form] ?? '◆'),
      h('span', { className: 'ad3-ev-title' }, title),
      line ? h('span', { className: 'ad3-ev-line', title: line }, line) : null,
      tag ? h('span', { className: 'ad3-ev-tag' }, tag) : null)
  }
  // A delivery that came with reminders says the first one in its own words; the
  // rest wait behind a count instead of a hover-only badge in the dock.
  const warns = Array.isArray(box.warnings) ? box.warnings.filter(Boolean) : []
  return h('div', { className: 'ad3 ad3-ev', 'data-tone': tone },
    h('div', { className: 'ad3-ev-head' },
      h('span', { className: 'ad3-ev-dot', 'aria-hidden': true }),
      h('span', { className: 'ad3-ev-title' }, title),
      h('span', { className: 'ad3-ev-spacer' }),
      box.meta ? h('span', { className: 'ad3-ev-meta' }, box.meta) : null,
      tag ? h('span', { className: 'ad3-ev-tag' }, tag) : null),
    line ? h('div', { className: 'ad3-ev-body' },
      h('span', { className: 'ad3-ev-line', title: line }, line)) : null,
    warns.length ? h('div', { className: 'ad3-ev-warn', title: warns.join('\n') },
      h('b', { 'aria-hidden': true }, '!'),
      h('span', null, warns[0]),
      warns.length > 1 ? h('span', { className: 'ad3-ev-more' }, `+${warns.length - 1}`) : null) : null)
}

/** The pair of marks a unit row carries: what was saved before, and after. */
function Seals({ pair }) {
  const before = pair?.before
  const after = pair?.after
  return h('span', {
    className: 'ad3-seals',
    title: `${before?.label ?? '开始前'} ${before ? `已存 #${before.seq}` : '未存'} · ${after?.label ?? '完成后'} ${after ? `已存 #${after.seq}` : '未存'}`,
  },
  h('span', { className: 'ad3-seal', 'data-on': before ? 'true' : 'false' }, '前'),
  h('span', { className: 'ad3-seal', 'data-on': after ? 'true' : 'false' }, '后'))
}

const pairOf = (marks, unitId) => {
  const rows = (Array.isArray(marks) ? marks : []).filter(row => row && (row.unit === unitId || row.boss === unitId))
  if (!rows.length) return undefined
  const pick = tag => [...rows].reverse().find(row => row.tag === tag)
  return { before: pick('before'), after: pick('after') }
}

function packetsOf(units, openOf = () => false, onOpen = () => {}, delegated = new Map(), marks = []) {
  // One progress line: a dot, the sentence in the model's own words, and the
  // time on a shared right edge. A line is never rewritten to look like a claim.
  const noteLine = (entry, className, key) => h('div', { key, className },
    h('span', { className: 'ad3-dot', 'aria-hidden': true }),
    h('span', { className: 'ad3-note-text', title: entry.text }, entry.text),
    h('span', { className: 'ad3-clock', title: entry.at ?? '' }, clockOf(entry.at)))
  // What is still owed floats to the top of the card; what is settled sinks to
  // the bottom, where a shorter row can be skimmed past. Plan order is kept
  // inside each half — this is a reading order, not a second plan.
  const ranked = [...units].sort((left, right) => (left.state === 'done' ? 1 : 0) - (right.state === 'done' ? 1 : 0))
  return h('ol', { className: 'ad3-units' }, ranked.map(unit => {
    const trail = Array.isArray(unit.notes) ? unit.notes : []
    const used = delegated.get(unit.id) ?? 0
    const newest = trail.length > 0 ? trail[trail.length - 1] : undefined
    // A finished row is a title, nothing else: its trail is history, and one line
    // of it under every checked item turned the card into a log. Only the row in
    // flight shows where it currently stands.
    const live = unit.state === 'active'
    const older = live ? trail.slice(0, -1).reverse() : []
    // What the unit said it did, each line marked by whether a recorded execution
    // backs it. A finished row opens to these, not to its trail.
    const claims = Array.isArray(unit.claims) ? unit.claims.filter(claim => claim && claim.text) : []
    const proven = claims.filter(claim => claim.proven).length
    const expandable = older.length > 0 || claims.length > 0
    const open = expandable && openOf(unit.id)
    const toggle = () => onOpen(unit.id)
    return h('li', { key: unit.id, className: 'ad3-row-wrap', 'data-state': unit.state },
      h('div', {
        className: `ad3-row${expandable ? ' ad3-row-openable' : ''}`,
        'data-state': unit.state,
        // The whole row is the target, not a 10px glyph: a row with a trail is a
        // disclosure (click, or Enter/Space on the keyboard). A row without one
        // stays inert, so nothing looks clickable that would do nothing.
        ...(expandable ? {
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': `${open ? '收起' : '展开'} ${unit.goal} 的进度（共 ${trail.length} 条）`,
          title: open ? '收起更早的进度' : `${trail.length} 条进度，点开看更早的`,
          onClick: toggle,
          onKeyDown: event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle() }
          },
        } : {}),
      },
        h('div', { className: 'ad3-row-head' },
          // The running row's triangle is drawn by CSS, not a glyph: U+25B6 and
          // its neighbours live in emoji-capable ranges, and a browser that hands
          // them to the emoji font ignores `color` entirely (it came out blue
          // against a green row). A border triangle is just ink, so it takes the
          // accent like everything else.
          h('span', {
            className: unit.state === 'active' ? 'ad3-mark ad3-mark-play' : 'ad3-mark',
            'aria-hidden': true,
          }, unit.state === 'active' ? '' : unitMark(unit.state)),
          h('span', { className: 'ad3-goal-cell' },
            h('span', { className: 'ad3-goal-text', title: unit.goal }, unit.goal)),
          // A unit that promised something says so on its own row: the deliverable
          // is what a person would be shown, and the two marks say a before/after
          // pair exists. Neither is a claim about whether it worked.
          unit.deliverable
            ? h('span', { className: 'ad3-deliv', title: `能给人看的：${unit.deliverable}` }, '交付')
            : null,
          pairOf(marks, unit.id) ? h(Seals, { pair: pairOf(marks, unit.id) }) : null,
          unit.asked
            ? h('span', { className: 'ad3-ask', title: unit.asked }, '需要你')
            : null,
          // How many lines this packet holds: one glance says whether opening it
          // is worth a click. It sits against the goal, not at the far edge.
          trail.length > 1
            ? h('span', { className: 'ad3-count', title: `${trail.length} 条进度` }, trail.length)
            : null,
          claims.length
            ? h('span', { className: 'ad3-proofs', 'data-weak': proven < claims.length ? 'true' : 'false', title: `${claims.length} 条声明，${proven} 条有执行证据` }, `实测 ${proven}/${claims.length}`)
            : null,
          used
            ? h('span', { className: 'ad3-delegated', title: `这个 packet 用过 ${used} 个子代理；派出、活动和回报都写在下方的 notes 里` }, `子代理 ${used}`)
            : null,
          h('span', { className: 'ad3-spacer' }),
          // Only the packet that is moving earns a word: five rows all saying 未开始 is noise.
          unit.state === 'active' || unit.state === 'blocked'
            ? h('span', { className: 'ad3-num' }, unitWord(unit.state))
            : null),
        // A unit in flight says what it owes, in its own sentence: the promise is
        // the thing a person would ask about, and a hover title is not a panel.
        unit.deliverable && unit.state === 'active'
          ? h('div', { key: 'promise', className: 'ad3-row-promise', title: unit.deliverable },
            h('span', { className: 'ad3-promise-label' }, '要交'),
            h('span', { className: 'ad3-promise-text' }, unit.deliverable))
          : null,
        live && newest ? noteLine(newest, 'ad3-note-line', 'newest') : null),
      open && claims.length
        ? h('ul', { className: 'ad3-claims' }, claims.map((claim, index) => h('li', { key: `${unit.id}-claim-${index}`, className: 'ad3-claim' },
          h('span', { className: 'ad3-proof', 'data-proven': claim.proven ? 'true' : 'false', title: claim.proven ? (claim.command ?? '有执行记录') : '没有执行记录，要人按步骤看' }, claim.proven ? '实测' : '人工'),
          h('span', null, claim.text))))
        : null,
      open && older.length
        ? h('ol', { className: 'ad3-notes' }, older.map((entry, index) => h('li', {
          key: `${unit.id}-${index}`, className: 'ad3-note-wrap',
        }, noteLine(entry, 'ad3-note-row', `${unit.id}-${index}-line`))))
        : null)
  }))
}

/** 「第 N 步」 or 「<主题> · 第 k 步」: a person never reads a unit id. */
function stepOf(state, id) {
  const groups = state.milestones ?? []
  const units = (state.units ?? []).filter(unit => !groups.some(group => group.id === unit.id))
  const unit = units.find(row => row.id === id)
  if (!unit) return '这一步'
  if (unit.parent && unit.parent !== 'daily') {
    const group = groups.find(row => row.id === unit.parent)
    const siblings = units.filter(row => row.parent === unit.parent)
    return `${group?.label || '这一组'} · 第 ${siblings.indexOf(unit) + 1} 步`
  }
  return `第 ${units.filter(row => !row.parent || row.parent === 'daily').indexOf(unit) + 1} 步`
}

function unitList(state, foldOf = () => false, onToggle = () => {}, openOf = () => false, onOpen = () => {}, delegated = new Map(), marks = []) {
  // With no real theme the 日需 bucket is just the plan: its steps show flat, not folded into
  // 「日需 · 小动作」 (v54: a 3-step plan read as one closed card).
  const themed = (state.milestones ?? []).some(group => group.role !== 'daily')
  const groups = themed ? state.milestones ?? [] : []
  const units = themed ? state.units ?? [] : (state.units ?? []).filter(unit => unit.id !== 'daily').map(unit => (unit.parent === 'daily' ? { ...unit, parent: undefined } : unit))
  const byId = new Map(groups.map(group => [group.id, group]))
  const loose = units.filter(unit => !unit.parent && !byId.has(unit.id))
  const ordered = [...groups.filter(group => group.role !== 'daily'), ...groups.filter(group => group.role === 'daily')]
  const cards = ordered.map(group => {
    const done = group.units.filter(child => child.state === 'done').length
    const folded = foldOf(group.id)
    return h('section', { key: group.id, className: group.role === 'daily' ? 'ad3-group ad3-group-daily' : 'ad3-group', 'data-state': group.state, 'data-folded': folded ? 'true' : 'false' },
      h('button', {
        type: 'button', className: 'ad3-group-head', 'aria-expanded': folded ? 'false' : 'true',
        title: folded ? '展开这一步' : '收起这一步',
        onClick: () => onToggle(group.id),
      },
      // One triangle per card, and it is the caret: a mark glyph beside it made
      // the head read as two controls doing the same thing.
      h('span', { className: 'ad3-caret', 'data-open': folded ? 'false' : 'true', 'aria-hidden': true }, '›'),
      h('span', { className: 'ad3-group-label', title: group.label }, group.label),
      // The theme's own word: a card that closed says so, and does not lean on
      // the count alone to explain why the rows are gone.
      group.role === 'daily'
        ? h('span', { className: 'ad3-theme-state', title: '日需：没归到战役主题的小动作都放这里，它不会收束' }, '小动作')
        : h('span', { className: 'ad3-theme-state', 'data-state': group.state }, group.state === 'done' ? '已收' : group.state === 'active' ? '进行中' : ''),
      h('span', { className: 'ad3-spacer' }),
      h('span', { className: 'ad3-num' }, `${done}/${group.units.length}`)),
      folded ? null : packetsOf(group.units, openOf, onOpen, delegated, marks))
  })
  // A flat plan gets no container: a headless box around one or two rows reads
  // as a card that forgot its title.
  if (!cards.length) return packetsOf(loose, openOf, onOpen, delegated, marks)
  return h('div', { className: 'ad3-groups' },
    loose.length ? h('section', { key: 'loose', className: 'ad3-group ad3-group-loose' }, packetsOf(loose, openOf, onOpen, delegated, marks)) : null,
    cards)
}

function basename(path) {
  if (typeof path !== 'string' || path === '') return ''
  const parts = path.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path
}

function shortRef(ref) {
  if (typeof ref !== 'string') return ''
  const tail = ref.split('/').pop() ?? ref
  return tail.length > 12 ? `${tail.slice(0, 12)}…` : tail
}

function row(label, value, options = {}) {
  if (value === null || value === undefined || value === '') return null
  return h('div', { key: label, className: 'ad3-asset' },
    h('span', { className: 'ad3-asset-label' }, label),
    h('span', { className: options.mono ? 'ad3-asset-value ad3-mono-value' : 'ad3-asset-value', title: options.title ?? undefined }, value))
}

/** The four gates are the promises the panel is allowed to make; show which are armed. */
function gateRow(gates) {
  if (!gates || typeof gates !== 'object') return null
  const names = [['evidence', '证据'], ['scope', '范围'], ['authorization', '授权'], ['plan', '计划']]
  const chips = names.map(([key, label]) => h('span', {
    key, className: gates[key] ? 'ad3-gate on' : 'ad3-gate', title: gates[key] ? `${label}门：这次任务会校验` : `${label}门：这次车道不校验`,
  }, label))
  return h('div', { key: 'gates', className: 'ad3-asset' },
    h('span', { className: 'ad3-asset-label' }, '校验'),
    h('span', { className: 'ad3-gates' }, chips))
}

/**
 * The machinery, behind one line.
 *
 * Every row here answers a question the owner only asks while something is being
 * argued about: which directory this writes into, what command proves it, which
 * gates are armed, what the project has learned, where the snapshots are, who did
 * the work. That is worth one click, not six lines above the delivery they came
 * for — a board that shows its own instrumentation reads as a dashboard, and the
 * owner stops reading the part that changes.
 */
function factsBody(state) {
  const assets = state.assets ?? {}
  const memory = assets.memory ?? null
  const checkpoint = assets.checkpoint ?? null
  const rows = [
    row('仓库', state.project, { mono: true }),
    row('检查', assets.verifier ?? '未探测到检查命令', { mono: Boolean(assets.verifier) }),
    gateRow(state.gates),
    memory && (memory.facts || memory.incidents)
      ? row('记忆', `${memory.facts} 条事实 · ${memory.incidents} 条教训`, { title: (memory.items ?? []).join('\n') })
      : row('记忆', '还没有记住任何东西'),
    row('回执', state.hasReceipt ? '已记录（不代表用户已确认）' : '未记录', { title: '目标 / 验收 / 不做 / 已接受的默认，四行一屏' }),
    state.goalRevision > 1
      ? row('目标', `第 ${state.goalRevision} 版 · ${state.goalHistory.join(' / ')}`, { title: '旧的说法，按时间倒序' })
      : row('目标', '第 1 版（没改过）'),
    row('澄清', state.clarify
      ? `${state.clarify.asked} 问 · ${state.clarify.answered} 答${state.clarify.waiting === 'user-answer' ? ' · 等待回答' : state.clarify.waiting === 'user-choice' ? ' · 等待选择' : state.clarify.assumption ? ' · 用了默认' : ''}`
      : '未记录澄清', { title: state.clarify?.pending?.length ? state.clarify.pending.join('；') : state.clarify?.assumption ?? '没有澄清记录不代表需求已确认' }),
    checkpoint && checkpoint.count
      ? row('存档', `${checkpoint.count} 个 · ${shortRef(checkpoint.ref)}`, { mono: true, title: checkpoint.ref ?? '' })
      : row('存档', '本次没有快照'),
  ].filter(Boolean)
  return h('div', { className: 'ad3-facts-body' }, rows)
}

/**
 * A goal is often a paragraph, not a title. Four lines are enough to recognise
 * it; the rest stays one click away, so the plan below is not pushed off screen
 * by the request that produced it.
 */
function Goal({ text }) {
  const [open, setOpen] = useState(false)
  const long = typeof text === 'string' && text.length > 120
  const clamped = long && !open
  return h('div', { className: 'ad3-goal-wrap' },
    h('h2', { className: `ad3-goal${clamped ? ' is-clamped' : ''}`, title: long ? text : undefined }, text),
    long ? h('button', {
      type: 'button',
      className: 'ad3-goal-more',
      'aria-expanded': open ? 'true' : 'false',
      onClick: () => setOpen(value => !value),
    }, open ? '收起目标' : '展开目标') : null)
}

function delegatedUnits(state) {
  const counts = new Map()
  for (const child of Array.isArray(state.children) ? state.children : []) {
    if (child && typeof child.unit === 'string' && child.unit !== '') {
      counts.set(child.unit, (counts.get(child.unit) ?? 0) + 1)
    }
  }
  return counts
}

// The project's history, newest first. The board above is one task; this is the
// chain a person reads to remember what the project has been through. A past task
// opens as a list of its units — it is a record, not something to act on.
const TASK_WORD = { active: '进行中', paused: '暂停', review_ready: '等你用过', closed: '已收束', cancelled: '已取消' }
const taskWord = state => TASK_WORD[state] ?? (typeof state === 'string' ? state : '')
function shortDate(value) {
  if (typeof value !== 'string' || value.length < 16) return ''
  const when = new Date(value)
  if (Number.isNaN(when.getTime())) return ''
  const pad = number => String(number).padStart(2, '0')
  return `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`
}

function Timeline({ rows, openOf, onOpen }) {
  const list = Array.isArray(rows) ? rows.filter(row => row && typeof row.id === 'string') : []
  // One task is not a history worth a heading: the board already says it.
  if (list.length < 2) return null
  return h('div', { className: 'ad3-section ad3-timeline' },
    h('div', { className: 'ad3-section-head' },
      h('span', { className: 'ad3-eyebrow' }, '时间线'),
      h('span', { className: 'ad3-note ad3-inline-note' }, `${list.length} 个任务`)),
    h('ul', { className: 'ad3-tl' }, list.map(row => {
      const open = openOf(row.id)
      const units = Array.isArray(row.units) ? row.units : []
      const meta = [taskWord(row.state), row.themes ? `${row.themes} 主题` : '', row.marks ? `${row.marks} 存档` : '']
        .filter(Boolean).join(' · ')
      return h('li', {
        key: row.id, className: 'ad3-tl-item',
        'data-current': row.current ? 'true' : undefined, 'data-state': row.state ?? undefined,
      },
        h('button', {
          type: 'button', className: 'ad3-tl-head', 'aria-expanded': open ? 'true' : 'false',
          title: row.goal || row.id, onClick: () => onOpen(row.id),
        },
          h('span', { className: 'ad3-tl-when' }, shortDate(row.at)),
          h('span', { className: 'ad3-tl-dot', 'aria-hidden': 'true' }),
          h('span', { className: 'ad3-tl-goal' }, row.goal || '（未写目标）'),
          row.current ? h('span', { className: 'ad3-tl-now' }, '当前') : null,
          h('span', { className: 'ad3-spacer' }),
          h('span', { className: 'ad3-tl-meta' }, meta),
          h('span', { className: 'ad3-caret', 'data-open': open ? 'true' : undefined }, '›')),
        open && units.length
          ? h('ul', { className: 'ad3-tl-units' }, units.map(unit => h('li', {
            // A step sits indented under its theme's own row; repeating the theme name squeezed the step's goal out (v58).
            key: unit.id, className: 'ad3-tl-unit', 'data-state': unit.state, style: unit.parent ? { paddingLeft: 18 } : undefined,
          },
            h('span', { className: 'ad3-mark' }, unitMark(unit.state)),
            h('span', { className: 'ad3-tl-unit-goal' }, unit.goal))))
          : null)
    })))
}

function Board({ useProjection }) {
  const state = useProjection('dshAutoDev')
  // Collapsing is a property of the reader, not of the task: a finished milestone is
  // collapsed the first time it is seen, and whatever the reader opens stays open
  // while the fold keeps producing new state objects.
  const [folded, setFolded] = React.useState({})
  // A packet's trail is collapsed by default: the row already carries the newest
  // line, and the older ones are only worth reading on demand.
  const [opened, setOpened] = React.useState({})
  if (!state) {
    return h('section', { className: 'ad3 ad3-pane', 'aria-label': 'Auto Dev 看板' },
      h('style', null, css),
      h('div', { className: 'ad3-empty' },
        h('span', { className: 'ad3-eyebrow' }, 'Auto Dev'),
        h('p', { className: 'ad3-note' }, '开始任务后，这里显示目标、分步与每一次交付。')))
  }
  const last = state.last
  const counting = state.counting ?? {}
  const done = counting.done ?? 0
  const total = counting.total ?? 0
  const foldOf = id => {
    if (folded[id] !== undefined) return folded[id]
    const group = (state.milestones ?? []).find(row => row.id === id)
    // The bucket starts folded: it is where small work lands, not the first thing
    // an owner should have to scroll past.
    return group?.role === 'daily' ? true : group?.state === 'done'
  }
  const onToggle = id => setFolded(previous => ({ ...previous, [id]: !(previous[id] === undefined ? (state.milestones ?? []).find(group => group.id === id)?.state === 'done' : previous[id]) }))
  // The bucket is drawn, but it is not a campaign: counting it as a theme made
  // "1 个主题" appear on plans that had no theme at all.
  const campaigns = (state.milestones ?? []).filter(group => group.role !== 'daily')
  // A task with no plan is still one step: the task itself, its state from the record.
  const steps = state.units?.length ? state.units
    : state.taskId ? [{ id: 'task', goal: state.goal || state.request || '', state: ['review_ready', 'closed'].includes(state.taskState) ? 'done' : state.taskState === 'active' ? 'active' : 'pending' }]
      : []
  const milestoneDone = campaigns.filter(group => group.state === 'done').length
  return h('section', { className: 'ad3 ad3-pane', 'aria-label': 'Auto Dev 看板' },
    h('style', null, css),
    // Title first, facts under it: a pane is read top-down, and the eyebrow that
    // names the lane belongs above the thing it describes, not beside a rule.
    h('div', { className: 'ad3-head' },
      h('div', { className: 'ad3-head-top' },
        h('span', { className: 'ad3-eyebrow' }, laneWord(state)),
        h('span', { className: 'ad3-spacer' }),
        h(State, { state })),
      h(Goal, { text: state.goal || state.request || '（未写目标）' }),
      // A goal that was revised is not a mistake to hide: the number says how many
      // times the person's mind changed, and the old sentences stay in the record.
      (state.goalRevision ?? 0) > 1
        ? h('p', { className: 'ad3-under' }, `第 ${state.goalRevision} 版 · 之前的目标留在工程记录里`)
        : null,
      // The program is a bigger intention than the task; when they differ, say so
      // once, quietly, instead of stacking a second heading under the first.
      state.program && state.program !== (state.goal || state.request)
        ? h('p', { className: 'ad3-under' }, state.program)
        : null,
      h('div', { className: 'ad3-meta' },
        h(Rail, { done, total, pending: 0, label: counting.label }),
        // The mode the person switched on comes right after the state: a narrow panel wraps, it never hides it.
        state.auto ? h('span', { className: 'ad3-num', title: '不等你确认，按最佳做法往下做；收不回的事照样留给你' }, '自动驾驶') : null,
        state.project ? h('span', { className: 'ad3-num', title: state.project }, basename(state.project)) : null,
        // Old tasks carry checkpoints written before a checkpoint belonged to a
        // unit; without this line their archives were invisible everywhere.
        (state.checkpoints ?? 0) > 0 ? h('span', { className: 'ad3-num', title: '本任务存过的存档数' }, `存档 ${state.checkpoints}`) : null,
        // Reminders read in the last delivery below, in their own words; a count
        // here as well was the same fact twice.
        state.warnings && warningLines(state).length && !state.last ? h('span', { className: 'ad3-num ad3-warn', title: warningLines(state).join('\n') }, warningsLabel(state.warnings)) : null)),
    // The bar for done, as the model understood the request: what the person checks the work against,
    // so it sits right under the task, open, set apart from body text. Nothing written, no card.
    state.acceptance?.length || state.unverified?.length
      ? h('div', { className: 'ad3-req' },
        h('span', { className: 'ad3-eyebrow' }, '要求'),
        state.acceptance?.length ? h('ol', null, state.acceptance.map((line, index) => h('li', { key: index }, line))) : null,
        state.unverified?.length
          ? h('div', { className: 'ad3-req-miss' },
            h('span', { className: 'ad3-eyebrow' }, '没做的'),
            h('ul', null, state.unverified.map((line, index) => h('li', { key: index }, line))))
          : null)
      : null,
    steps.length
      ? h('div', { className: 'ad3-section' },
        h('div', { className: 'ad3-section-head' },
          h('span', { className: 'ad3-eyebrow' }, '分步'),
          campaigns.length
            ? h('span', { className: 'ad3-note ad3-inline-note' }, `${campaigns.length} 个主题${milestoneDone ? ` · ${milestoneDone} 已收` : ''}`)
            // No container and a long list: say what the plan is instead of drawing
            // eight peers and letting the reader guess whether that was intended.
            : steps.length > 5
              ? h('span', { className: 'ad3-note ad3-inline-note ad3-ungrouped', title: '这个计划没有分组：如果其中有两条以上独立的验收目标，可以给它们立一个 theme' }, '未分组')
              : null),
        unitList({ ...state, units: steps }, foldOf, onToggle,
          id => opened[id] === true,
          id => setOpened(previous => ({ ...previous, [id]: !previous[id] })),
          delegatedUnits(state),
          state.marks ?? []))
      : null,
    last
      ? h('div', { className: 'ad3-last' },
        h('div', { className: 'ad3-last-line' },
          h('span', { className: 'ad3-eyebrow' }, last.unit ? `最近一次交付 · ${stepOf(state, last.unit)}` : '最近一次交付'),
          h('span', { style: { flex: 1 } }),
          h('span', { className: 'ad3-outcome', 'data-outcome': last.outcome ?? '' }, outcomeWord(last.outcome))),
        last.summary ? h('p', { className: 'ad3-summary' }, last.summary) : null,
        warningLines(state).length
          ? h('p', { className: 'ad3-last-warn', title: warningLines(state).join('\n') }, h('b', { 'aria-hidden': true }, '!'), h('span', null, warningLines(state)[0]), warningLines(state).length > 1 ? h('span', { className: 'ad3-ev-more' }, `+${warningLines(state).length - 1}`) : null)
          : null,
        last.residue?.length ? h('p', { className: 'ad3-note' }, `未完成 · ${last.residue.join('、')}`) : null,
        live(state) && cleanNext(state.next) ? h('p', { className: 'ad3-note' }, `接下来 · ${cleanNext(state.next)}`) : null)
      : null,
    // The project's history belongs under the current task, not above it: what is
    // moving now is what the owner opens the panel for, and a stack of past tasks
    // on top pushes the running themes below the fold.
    h(Timeline, {
      rows: state.timeline,
      openOf: id => opened[`tl:${id}`] === true,
      onOpen: id => setOpened(previous => ({ ...previous, [`tl:${id}`]: !previous[`tl:${id}`] })),
    }),
    h('details', { className: 'ad3-facts' },
      h('summary', null, '工程记录'),
      factsBody(state)),
  )
}

// Exported for the offline preview harness (scripts/preview-board.mjs); the host
// loader only reads `apply` and `inject`.
export { Board, StreamCard, css }

export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'uiConversation']

export function apply(ctx) {
  const tabId = 'dsh-auto-dev/board'
  const kind = 'dsh-auto-dev-board'

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: tabId,
    kind,
    title: () => 'Auto Dev',
    guide: [{ id: 'board', order: 20, title: () => 'Auto Dev', description: () => '任务、分步与最近一次交付' }],
  }), 'dsh-auto-dev board tab')

  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'dsh-auto-dev-dock',
    order: -18,
    inject: () => ({ openBoard: () => ctx.sidebarRight.openTab(kind) }),
  }, Bar)), 'dsh-auto-dev dock bar')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: tabId,
  }, Board)), 'dsh-auto-dev board body')

  // The conversation's own node type. Two halves that must arrive together: the
  // claim (`exclusive` hides the generic context row) and the view that draws it.
  // A claim without its view is a message that renders as nothing — worse than the
  // plain row it replaced. So the view mounts first, and the claim follows only if
  // it did; if either half fails, both are released and the row stays.
  let releaseCards = null
  try {
    const unview = ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'auto-dev-event',
    }, StreamCard))
    const unclaim = ctx.uiConversation.events.register({
      kind: 'auto-dev-event',
      target: 'chat',
      match: event => {
        if (event?.type !== 'user/message') return null
        const source = event.data?.source
        // Must equal the `source.kind` the host half writes in notice(): a mismatch
      // here silently un-claims every card and the rows fall back into the process fold.
      if (!source || source.kind !== 'dsh-auto-dev') return null
        // Plain progress notices keep the compact row they already had; only the
        // events that carry a form earn a card.
        if (!source.form || source.form === 'notice') return null
        return { id: String(event.data.id ?? event.seq), role: 'start', exclusive: true }
      },
      start: (_context, match) => {
        const event = match.event
        const source = event?.data?.source ?? {}
        const text = Array.isArray(event?.data?.content)
          ? (event.data.content.find(item => item?.type === 'text')?.text ?? '')
          : ''
        return { seq: event.seq, time: event.time, form: source.form, data: source.data ?? null, text, summary: source.summary ?? '' }
      },
      update: context => context.state,
      // Never null: a node that exists but cannot be built still has to reach the
      // screen, or the claim above has hidden it for good.
      buildViewNode: context => {
        const state = context.state
        const claimed = context.start?.event
        const source = claimed?.data?.source
        const seq = state?.seq ?? claimed?.seq ?? 0
        const { seq: _seq, ...data } = state ?? {
          form: source?.form ?? null,
          data: source?.data ?? null,
          text: '',
          summary: source?.summary ?? '',
        }
        return {
          key: context.key,
          kind: 'auto-dev-event',
          id: context.id,
          target: 'chat',
          anchorSeq: seq,
          location: context.start?.location ?? { kind: 'unresolved' },
          visibility: 'visible',
          // Outside the Turn's process group. A task being worked on has to stay
          // watchable while it runs; folded into the process it is invisible until
          // somebody opens the group, which is the same as not reporting at all.
          groupTree: 'exchange',
          data,
        }
      },
    })
    releaseCards = () => {
      if (typeof unclaim === 'function') unclaim()
      if (typeof unview === 'function') unview()
    }
    ctx.effect(() => releaseCards, 'dsh-auto-dev stream cards')
  } catch (error) {
    // Neither half stays: the plain context row is the floor, and it must not be
    // traded for a card that cannot draw.
    if (typeof releaseCards === 'function') releaseCards()
    releaseCards = null
    console.warn('dsh-auto-dev: stream cards unavailable on this build; status events stay as plain rows', error)
  }
}
