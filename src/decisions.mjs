/**
 * Who decided, read off the log by order — never by matching the model's quote
 * against the person's words (设计约定「门禁定义」②④). The person's latest word
 * after a point in the session is the decision; a refusal is the only thing read
 * out of its text.
 */
import { collectObservations } from './session-log.mjs'

const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim()


/** The host hands a question card's answer back as JSON: what the person picked or typed, as they said it. */
function answerText(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch { return text }
  const said = (Array.isArray(parsed?.answers) ? parsed.answers : [])
    .flatMap(answer => [...(Array.isArray(answer?.selected) ? answer.selected : []), answer?.custom])
    .map(value => normalize(typeof value === 'string' ? value : value?.label)).filter(Boolean)
  return said.length ? said.join('；') : text
}

/** What the person said after `after`: typed messages and answers to a question card, oldest first. */
export function repliesAfter(agent, after = -1) {
  const session = agent?.session
  const replies = []
  for (let seq = after + 1; seq < (session?.seq ?? 0); seq++) {
    const event = session.eventAt(seq)
    const message = event?.data?.message ?? event?.data
    if (event?.type !== 'user/message' || message?.source?.kind !== 'user') continue
    const text = normalize((message.content ?? []).filter(row => row.type === 'text').map(row => row.text).join('\n'))
    if (text) replies.push({ seq, text, via: 'user-message', ...(message.id ? { messageId: message.id } : {}) })
  }
  for (const row of collectObservations(session).results) {
    if (row.seq <= after || !/ask_user_question$/.test(row.name ?? '') || row.isError) continue
    const text = answerText(normalize((row.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')))
    if (text) replies.push({ seq: row.seq, text, via: 'option-choice', callId: row.callId })
  }
  return replies.sort((a, b) => a.seq - b.seq)
}

/**
 * The person's latest word since `after` (a recorded session seq), as a decision source, or undefined when
 * they have not spoken since. Never throws: no answer yet is a fact, not an error.
 */
export function decisionSource({ agent, task, after = task?.startedSeq ?? 0, subject } = {}) {
  // Recorded seqs are the session's next seq at the time, so a reply at that seq came after.
  const reply = repliesAfter(agent, after - 1).at(-1)
  if (!reply) return undefined
  return { sessionId: agent?.session?.id, seq: reply.seq, via: reply.via, quote: reply.text,
    ...(reply.messageId ? { messageId: reply.messageId } : {}), ...(reply.callId ? { callId: reply.callId } : {}),
    ...(task?.id ? { taskId: task.id } : {}), ...(subject ? { subject } : {}) }
}

/** The two options a hard gate offers when the host has no yes/no card of its own. */
export const CONSENT_YES = '同意，照做'
export const CONSENT_NO = '不同意，换做法'
export const CONSENT_ASK = `用问题卡问用户，只给两个选项「${CONSENT_YES}」「${CONSENT_NO}」`

/** Whether the person picked `label` on a question card after `after`: the option label, compared as is. */
export function picked(agent, after, label = CONSENT_YES) {
  for (const row of collectObservations(agent?.session).results) {
    if (row.seq <= after || !/ask_user_question$/.test(row.name ?? '') || row.isError) continue
    const text = (row.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
    let parsed
    try { parsed = JSON.parse(text) } catch { continue }
    const answers = Array.isArray(parsed?.answers) ? parsed.answers : []
    if (answers.some(answer => Array.isArray(answer?.selected) && answer.selected.includes(label))) return { seq: row.seq, via: 'option-choice', callId: row.callId, quote: label }
  }
  return undefined
}

/**
 * G2 / G3 by sequence. The first attempt is stopped and the model asks with two fixed
 * options; the person picking 「同意，照做」 lets this kind of action through for the rest
 * of the task. The option is the decision — the plugin reads no words (插件不干预语义).
 * Kept in session memory: after a restart the model asks once more.
 */
export function consent(state, agent, task, key, seq) {
  // `seq` is the session's next seq: anything picked from it on came after the stop.
  const last = seq - 1
  if (!(state.consent instanceof Map)) state.consent = new Map()
  const id = `${task.id}:${key}`
  const asked = state.consent.get(id)
  if (asked?.granted) return { granted: true, source: asked.granted }
  if (!asked) {
    state.consent.set(id, { seq: last })
    return { granted: false }
  }
  const choice = picked(agent, asked.seq)
  if (!choice) return { granted: false, waiting: true }
  asked.granted = choice
  return { granted: true, source: choice }
}

/** The pause/resume/cancel moves. One that does not apply is answered, not refused. */
export function controlTransition(state, operation) {
  const targets = { pause: 'paused', resume: 'active', continue: 'active', cancel: 'cancelled' }
  const target = targets[operation]
  if (!target) return { state, changed: false, answer: `不认识「${operation}」，什么都没动。` }
  if (state === target) return { state, changed: false }
  const allowed = { pause: ['active'], resume: ['paused'], continue: ['paused'], cancel: ['active', 'paused', 'review_ready'] }
  if (!allowed[operation].includes(state)) {
    return { state, changed: false, answer: state === 'review_ready' ? '这个任务在等用户验收：用户说可以就收案，说哪里不对就退回改。'
      : state === 'closed' ? '这个任务已经收案；要接着做请用户 /dsh-auto-dev adopt。' : `任务现在是 ${state}，这一步不适用，什么都没动。` }
  }
  return { state: target, changed: true }
}

/**
 * Whether the person said anything since the task started. The host splices the
 * request itself in as a user message (v31 #10), so that one — the start command
 * or text equal to the recorded request — is not a reply.
 */
export function spokeSinceStart(agent, task) {
  const request = String(task?.request ?? '').replace(/\s+/g, ' ').trim()
  // From the start command, not the registration: an answer to the clarifying question counts.
  return repliesAfter(agent, task?.openedSeq ?? task?.startedSeq ?? -1).some(reply => {
    const text = reply.text.replace(/\s+/g, ' ').trim()
    return !/^\/dsh-auto-dev\b/.test(text) && text !== request && !(request && (text.endsWith(request) || request.endsWith(text)))
  })
}
