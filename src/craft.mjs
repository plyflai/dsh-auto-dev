/** Event-specific methods. Emitting a hint never changes task state or grants authority. */
import { executionFailed, wasRefused } from './session-log.mjs'

export const CRAFT = [
  { key: 'ambiguity', doc: 'references/craft/bdd.md', line: '指出会改变实现或验收的歧义。能安全继续时声明假设；确实缺决策时只问一个核心问题。用一个具体输入和可见结果核对口径。',
    when: ({ task, unit }) => /模糊|不确定|待定|看着办|大概|随便|优化一下/.test(`${task?.request ?? ''} ${unit?.goal ?? ''}`) },
  { key: 'impact', doc: 'references/craft/impact.md', line: '改动前查入口、调用方和影响面。保留已有约束与行为，优先复用现成模块；用受影响路径的检查证明兼容。无需另填进度表。',
    when: ({ task, unit }) => task?.mode !== 'look' && Boolean(unit?.scope?.length || task?.scope?.length) },
  { key: 'debug', doc: 'references/craft/debug.md', line: '从真实失败输出建立最小复现。每次只验证一个假设，记录探针带来的新事实，再修根因并重跑。未知根因可以保留；技术排查继续，只有权限、业务决策或外部前提缺失才等待用户。',
    when: ({ failure }) => Boolean(failure) },
  { key: 'verification', doc: 'references/craft/verification.md', line: '对最后一次改动运行能证明验收的检查，并保留失败边界。界面有浏览器验收要求时真打开、操作并截图。只报告实际执行的结果，未验证项保持可见。',
    when: ({ task, unit, changed }) => changed || task?.state === 'review_ready' || unit?.kind === 'verification' || /验收|回归|检查/.test(unit?.goal ?? '') },
  { key: 'release', doc: 'references/craft/release.md', line: '交接时说明实际版本、加载入口、验证结果、限制和回滚路径。发布前核对已有授权与真实运行证据；源码检查通过不代表已部署或已验收。',
    when: ({ task, unit }) => /发布|上线|部署|交接|release|deploy/i.test(`${task?.goal || task?.request || ''} ${unit?.goal ?? ''}`) },
]

export function failureContext(rows = [], ledger = []) {
  const actual = rows.filter(row => !/^work_/.test(row.name ?? '') && !wasRefused(row))
  // Only evidence accepted as progress resets a different command's failure.
  // An unrelated successful probe is not progress by itself.
  const cited = new Set(ledger.filter(entry => ['partial', 'complete'].includes(entry.outcome))
    .flatMap(entry => (entry.claims ?? []).map(claim => claim.execution?.callId)).filter(Boolean))
  const progressSeq = Math.max(-1, ...actual.filter(row => cited.has(row.callId) && !executionFailed(row)).map(row => row.seq))
  const latest = actual.findLast(row => row.seq > progressSeq && executionFailed(row))
  if (!latest) return undefined
  const identity = row => `${row.name ?? ''}:${String(row.command ?? '').trim()}`
  const defect = row => Array.isArray(row.content) ? row.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() : String(row.content ?? '').trim()
  const key = identity(latest)
  const related = actual.filter(row => identity(row) === key)
  const success = related.findLast(row => !executionFailed(row))
  if (success && success.seq > latest.seq) return undefined
  // Where this run of failures began: the last accepted proof or the last time
  // this command passed. It is what a hint about the failure is keyed on, so the
  // same command failing again is the same problem, not a new one to announce.
  const since = Math.max(progressSeq, success?.seq ?? -1)
  const failures = related.filter(row => executionFailed(row) && row.seq > since && defect(row) === defect(latest))
  return { key, since, count: failures.length, callId: latest.callId, seq: latest.seq, command: latest.command ?? latest.name }
}

export function craftHints({ task, unit, seen, event, context, failure, changed } = {}) {
  return CRAFT.filter(page => (!event || page.key === event) && page.when({ task, unit, failure, changed }))
    .map(page => ({ ...page, identity: `${task?.id ?? 'session'}:${unit?.id ?? ''}:${page.key}:${(context?.[page.key] ?? (typeof context === 'string' && event ? context : undefined)) ?? (page.key === 'debug' ? `${failure?.key}:${failure?.since}` : `${unit?.goal || task?.goal || task?.request || ''}:${(unit?.scope ?? task?.scope ?? []).join(',')}`)}` }))
    .filter(page => !seen?.has?.(page.identity))
}

export function craftMessages(api, agent, input) {
  const state = api.sessionState(agent)
  if (!(state.craftSeen instanceof Set)) state.craftSeen = new Set()
  return craftHints({ ...input, seen: state.craftSeen }).map(page => {
    const fact = page.key === 'debug' ? `执行 ${input.failure.command} 失败 ${input.failure.count} 次` : input.fact || input.unit?.goal || input.task?.goal || input.task?.request || '当前工作'
    state.craftSeen.add(page.identity) // emitted, not a claim that the model read a document
    return api.notice(`事实：${fact}\n方法：${page.line}\n参考：${page.doc}`, `auto-dev-v3 method ${page.key}`, { form: 'read-doc', data: { unit: input.unit?.id ?? '', title: `方法提示 · ${page.key}`, line: page.line, tag: page.doc, tone: 'info' } })
  })
}
