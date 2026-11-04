/** Optional task notes share existing task fields; durable learning belongs to memory. */
import { MEMORY_FILE, remember } from './memory.mjs'

const kinds = new Set(['goal', 'receipt', 'clarify', 'alternative', 'learning'])
const clean = value => typeof value === 'string' ? value.trim() : ''

export function recordWaiting(task) {
  const clarify = task.clarify
  const answered = new Set((clarify?.answers ?? []).map(row => row.q))
  const questions = (clarify?.asked ?? []).filter(row => !answered.has(row.q)).map(row => row.q)
  if (questions.length && !clean(clarify?.assumption)) return { waiting: 'user-answer', lines: questions }
  return { waiting: null, lines: [] }
}

export function prepareRecords(args) {
  const legacy = args.operation === 'postmortem' ? 'learning' : args.operation
  const payload = args.payload ?? {}
  const rows = args.operation === 'record'
    // `record` with kind and text at the top level is how models write it (v22: six refusals in a row).
    ? (payload.entries ?? args.entries ?? [payload.kind ? payload : { ...args, ...payload }])
    : [{ ...args, ...payload, kind: legacy }]
  // Every entry is optional, so a wrong shape is digested: the kind is read off what the
  // entry carries, empty parts are dropped, and an entry with nothing in it records nothing.
  const LEARNING = ['symptom', 'cause', 'change', 'finding', 'prevention', 'check', 'lesson']
  const kindOf = row => kinds.has(row.kind) ? row.kind
    : row.asked || row.answers || row.assumption ? 'clarify'
      : LEARNING.some(key => clean(row[key])) ? 'learning'
        : row.verdict ? 'alternative' : 'receipt'
  const list = items => (Array.isArray(items) ? items : items ? [items] : [])
  return (Array.isArray(rows) ? rows : [rows]).filter(row => row && typeof row === 'object').map(row => {
    const kind = kindOf(row)
    const entry = { ...row, kind, text: clean(row.text) }
    if (kind === 'clarify') {
      entry.asked = list(row.asked).map(item => {
        const q = clean(typeof item === 'string' ? item : item?.q ?? item?.question)
        if (!q) return undefined
        const { question: _question, ...rest } = typeof item === 'object' ? item : {}
        return { ...rest, q }
      }).filter(Boolean)
      entry.answers = list(row.answers).map(item => {
        const q = clean(item?.q ?? item?.question)
        const answer = clean(typeof item === 'string' ? item : item?.answer)
        return answer ? { q: q || '（没写问题）', answer } : undefined
      }).filter(Boolean)
      entry.assumption = clean(row.assumption)
      if (!entry.asked.length && !entry.answers.length && !entry.assumption && !entry.text) return undefined
    } else if (kind === 'learning') {
      entry.sections = LEARNING.filter(key => clean(row[key])).map(key => [key, clean(row[key])])
      if (!entry.text && !entry.sections.length) return undefined
    } else if (!entry.text) return undefined
    if (row.verdict && !['kept', 'switched'].includes(row.verdict)) delete entry.verdict
    return entry
  }).filter(Boolean)
}

export async function recordTask(api, task, args, exec) {
  const entries = prepareRecords(args) // Validate the entire batch before any write.
  const results = []
  for (const entry of entries) {
    const now = new Date().toISOString()
    const by = api.sessionId(exec.agent)
    let result
    if (entry.kind === 'learning') {
      const details = Object.fromEntries(entry.sections)
      const saved = remember(task.project, { kind: 'incident', symptom: clean(entry.symptom) || entry.text || details.finding || details.change || details.prevention || details.cause,
        mechanism: details.cause, repair: details.change, finding: details.finding, prevention: details.prevention,
        ruledOut: entry.ruledOut, check: details.check, lesson: details.lesson }, { taskId: task.id, session: by })
      task = await api.records.change('tasks', task.id, current => ({ ...current, pulse: { ...(current.pulse ?? {}), postmortemAt: now } }))
      api.queueNotice(exec.agent, '**复盘已写** — 已记录观察与发现', 'dsh-auto-dev postmortem',
        { form: 'postmortem', data: { unit: task.id, title: '复盘', line: `已记录到 ${MEMORY_FILE}；${saved.status === 'observation' ? '根因未知，保留观察' : '机制按记录保留，复用前核对'}`, tag: '已写', tone: 'info' } })
      result = { ...saved, path: MEMORY_FILE, written: saved.stored }
    } else if (entry.kind === 'goal') {
      const unchanged = entry.text === task.goal
      task = await api.records.change('tasks', task.id, current => unchanged ? current : ({ ...current, goal: entry.text,
        goalHistory: [...(current.goalHistory ?? []), { at: now, text: entry.text, ...(clean(entry.why) ? { why: clean(entry.why) } : {}) }], updatedAt: now }))
      result = { goal: task.goal, goalRevision: (task.goalHistory ?? []).length, history: task.goalHistory ?? [], ...(unchanged ? { unchanged: true } : {}) }
    } else if (entry.kind === 'receipt') {
      task = await api.records.change('tasks', task.id, current => ({ ...current,
        receipt: { text: entry.text, at: now, by, firstAt: current.receipt?.firstAt ?? now }, updatedAt: now }))
      result = { receipt: task.receipt }
    } else if (entry.kind === 'clarify') {
      task = await api.records.change('tasks', task.id, current => ({ ...current, clarify: {
        ...(current.clarify ?? {}), asked: entry.asked.length ? entry.asked : current.clarify?.asked ?? [],
        answers: [...(current.clarify?.answers ?? []), ...entry.answers],
        ...(entry.asked.length || entry.assumption ? { assumption: entry.assumption || undefined } : {}), ...(entry.text ? { text: entry.text } : {}), at: now,
      }, updatedAt: now }))
      result = { clarify: { asked: task.clarify.asked.length, answered: task.clarify.answers.length, assumption: task.clarify.assumption ?? null } }
    } else {
      // Retired channel (F-clarify 6b: a better way is asked in the conversation, before
      // registering). An old call is still taken, kept as history only: no card, no waiting.
      const alternative = { text: entry.text, at: now, by,
        ...(entry.verdict ? { verdict: entry.verdict, quote: clean(entry.quote) } : {}) }
      task = await api.records.change('tasks', task.id, current => ({ ...current, alternatives: [...(current.alternatives ?? []), alternative], updatedAt: now }))
      result = { alternatives: task.alternatives.length, ...(entry.verdict ? { verdict: entry.verdict } : {}) }
    }
    results.push({ kind: entry.kind, ...result })
  }
  const pending = recordWaiting(task)
  if (entries.some(entry => entry.kind === 'clarify')) {
    const line = pending.lines.join('；')
    if (pending.waiting === 'user-answer') api.queueNotice(exec.agent, `**需要回答** — ${line}`, 'dsh-auto-dev clarify',
      { form: 'ask', data: { unit: task.id, title: '需要回答', line, tag: '等待回答', tone: 'ask' } })
  }
  return { taskId: task.id, ...(results.length === 1 ? results[0] : { entries: results }), waiting: pending.waiting,
    continueAuthorized: task.state === 'active' && !pending.waiting,
    tellUser: pending.waiting ? `向用户提出待决内容并等待回答：${pending.lines.join('；')}`
      : '有影响目标、验收或下一步的信息时，向用户说明，然后继续已授权工作；记录不代表用户确认。' }
}
