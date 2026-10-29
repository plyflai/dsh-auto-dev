/** Local decision checks. The model interprets intent; the log proves who answered which request. */
import { collectObservations } from './session-log.mjs'

const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const denial = /(?:不(?:同意|允许|接受|通过|可以|要)|不能|不可|别|禁止|拒绝|退回|重做|返工|未通过|not\s+(?:approved|allowed|accepted)|\b(?:no|deny|reject|rework)\b)/i
const affirmative = /^(?:好[的]?|可以|同意|允许|确认|接受|通过|收下|没问题|按这个来|yes|ok(?:ay)?|approved?|accepted?)(?:[，, ]*(?:就这样|按这个来|继续|执行))?[。.!！\s]*$/i

export function decisionSource({ agent, task, quote, after = task.startedSeq ?? -1, before = Infinity, subject, intent, sourceSeq, allowShort = true }) {
  const wanted = normalize(quote)
  if (!wanted) throw new Error('decision needs the person\'s exact answer in text/authorization/note')
  const sources = []
  const session = agent?.session
  for (let seq = 0; seq < (session?.seq ?? 0); seq++) {
    const event = session.eventAt(seq)
    const message = event?.data?.message ?? event?.data
    if (event?.type !== 'user/message' || message?.source?.kind !== 'user') continue
    const body = (message.content ?? []).filter(row => row.type === 'text').map(row => row.text).join('\n')
    sources.push({ seq, text: body, via: 'user-message', messageId: message.id })
  }
  for (const row of collectObservations(session).results) {
    if (!/ask_user_question$/.test(row.name ?? '') || row.isError) continue
    for (const block of row.content ?? []) if (block.type === 'text') sources.push({ seq: row.seq, text: block.text, via: 'option-choice', callId: row.callId, question: row.question })
  }
  const matches = row => normalize(row.text) === wanted || (row.via === 'option-choice' && (() => {
    try {
      const values = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(values) : []
      return values(JSON.parse(row.text)).some(value => normalize(value) === wanted)
    } catch { return false }
  })())
  const relevant = sources.filter(row => row.seq >= after && row.seq < before && (matches(row)
    || normalize(row.text).toLowerCase().includes(String(subject).toLowerCase())
    || affirmative.test(normalize(row.text)) || denial.test(normalize(row.text))))
  const source = relevant.sort((a, b) => b.seq - a.seq)[0]
  if (source && (!matches(source) || (sourceSeq !== undefined && source.seq !== sourceSeq))) {
    throw new Error('a newer decision supersedes the cited answer; use the latest relevant human response')
  }
  if (!source) throw new Error('decision source not found after this task/request: cite the person\'s full current answer, not an old message or a paraphrase')
  // Checking the full typed answer prevents quoting “允许” out of “不允许”.
  if (!['rework', 'environment', 'revoke', 'observation'].includes(intent) && denial.test(wanted)) throw new Error('the cited answer refuses or requests rework; it cannot grant acceptance or authority')
  if (['environment', 'revoke'].includes(intent) && /(?:^(?:不(?:同意|允许|可以|要|确认|接受|采用)|别|拒绝|no\b|deny\b|reject\b)|(?:不|别).{0,4}(?:撤销|解除|移除|更新|修改|确认|同意|接受|采用))/i.test(wanted)) {
    throw new Error('the cited answer refuses this environment change; the rule was not changed')
  }
  const question = normalize(JSON.stringify(source.question ?? ''))
  const boundChoice = source.via === 'option-choice' && question.includes(subject)
  // A bare yes belongs to the most recent question, not an older pending action.
  if (allowShort && affirmative.test(wanted)) {
    const questionCalls = collectObservations(session).results.filter(row => /ask_user_question$/.test(row.name ?? '') && row.seq >= after && row.seq <= source.seq)
    const lastQuestion = questionCalls.at(-1)
    if (lastQuestion && !normalize(JSON.stringify(lastQuestion.question ?? '')).includes(subject)) {
      throw new Error('the short answer belongs to another question; cite a response naming this decision')
    }
    for (let seq = source.seq - 1; seq >= after; seq--) {
      const event = session.eventAt(seq)
      if (event?.type !== 'assistant/message') continue
      const body = (event.data?.message?.content ?? event.data?.content ?? []).filter(row => row.type === 'text').map(row => row.text).join('\n')
      if (/[?？]/.test(body) && !body.includes(subject) && !(intent === 'accept' && /验收|收下|接受|accept|review/i.test(body))) {
        throw new Error('the short answer follows an unrelated assistant question; ask for an explicit decision')
      }
      break
    }
  }
  const namesSubject = wanted.toLowerCase().includes(String(subject).toLowerCase())
    || (intent === 'accept' && /(?:验收通过|接受这[个一]版|这[个一]版.*(?:通过|收下)|看过了[，, ]*(?:可以|通过)|accept.*(?:delivery|result))/i.test(wanted))
    || (intent === 'rework' && /(?:重做|返工|退回|修改|改成|没通过|不通过|缺|漏|不对|错误|少了|rework|revise)/i.test(wanted))
  if (!boundChoice && !namesSubject && !(allowShort && affirmative.test(wanted))) throw new Error(`answer is not associated with the pending decision (${subject}); ask only about this decision if intent is ambiguous`)
  if (intent === 'accept' && !/(?:验收通过|接受|收下|通过|看过了.*可以|看过了.*没问题|^(?:可以|好的?|同意|确认|没问题)|\b(?:accept(?:ed)?|approve[ds]?|yes|ok(?:ay)?)\b)/i.test(wanted)) throw new Error('the answer does not explicitly accept this delivery')
  if (intent === 'grant' && !/(?:同意|允许|授权|确认|可以|按.+执行|^(?:好的?|没问题)|\b(?:allow|authorize|approve[ds]?|yes|ok(?:ay)?|go ahead)\b)/i.test(wanted)) throw new Error('the answer does not explicitly authorize this action')
  if (intent === 'environment' && !/(?:确认|同意|接受|采用|\b(?:confirm(?:ed)?|approve[ds]?|accept(?:ed)?)\b)/i.test(wanted)) throw new Error('the answer does not explicitly confirm this environment candidate')
  if (intent === 'rework' && !denial.test(wanted) && !namesSubject) throw new Error('the cited answer does not request rework')
  return { sessionId: session.id, seq: source.seq, via: source.via, quote: wanted,
    ...(source.messageId ? { messageId: source.messageId } : {}), ...(source.callId ? { callId: source.callId } : {}), taskId: task.id, subject }
}

export function controlTransition(state, operation) {
  const targets = { pause: 'paused', resume: 'active', continue: 'active', cancel: 'cancelled' }
  const target = targets[operation]
  if (!target) throw new Error(`work_control: unknown operation "${operation}" — nothing was changed`)
  if (state === target) return { state, changed: false }
  const allowed = { pause: ['active'], resume: ['paused'], continue: ['paused'], cancel: ['active', 'paused', 'review_ready'] }
  if (!allowed[operation].includes(state)) throw new Error(`work_control ${operation} refuses task state ${state}: use accept/rework for review_ready, or explicitly adopt closed work; cancelled work needs a new task`)
  return { state: target, changed: true }
}

/** Legacy grants remain visible as history but cannot silently authorize a different action. */
export function grantsAction(task, risk, command, { agent, beforeSeq = Infinity } = {}) {
  return [...(task.decisions ?? [])].reverse().some(row => {
    if (!row.granted || row.risk !== risk || row.source?.taskId !== task.id
      || typeof row.action !== 'string' || normalize(row.action) !== normalize(command)
      || !Number.isInteger(row.atSeq) || row.atSeq > beforeSeq || row.source.seq >= beforeSeq) return false
    if (agent) {
      try { decisionSource({ agent, task, quote: row.source.quote, after: row.source.seq, before: beforeSeq,
        subject: command, intent: 'grant', sourceSeq: row.source.seq }) } catch { return false }
    }
    return true
  })
}
