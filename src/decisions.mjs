/**
 * Who decided, read off the log by order — never by matching the model's quote
 * against the person's words (设计约定「门禁定义」②④). The person's latest word
 * after a point in the session is the decision; a refusal is the only thing read
 * out of its text.
 */
import { collectObservations } from './session-log.mjs'

const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim()

/** A reply that says no. Anything else after the model asked is a yes to go on. */
export const REFUSAL = /(?:不(?:同意|允许|接受|通过|可以|要|行|用了)|不能|不可|别|禁止|拒绝|算了|取消|先不|退回|重做|返工|未通过|not\s+(?:approved|allowed|accepted)|\b(?:no|nope|deny|reject|rework|stop|cancel|don'?t)\b)/i

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
    const text = normalize((row.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n'))
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
  return { sessionId: agent?.session?.id, seq: reply.seq, via: reply.via, quote: reply.text, refused: REFUSAL.test(reply.text),
    ...(reply.messageId ? { messageId: reply.messageId } : {}), ...(reply.callId ? { callId: reply.callId } : {}),
    ...(task?.id ? { taskId: task.id } : {}), ...(subject ? { subject } : {}) }
}

/**
 * G2 / G3 by sequence. The first attempt is stopped and the model told to ask;
 * once the person has answered after that without refusing, this kind of action
 * is allowed for the rest of the task. Kept in session memory: after a restart
 * the model asks once more, which costs one question and loses nothing.
 */
export function consent(state, agent, task, key, seq) {
  // `seq` is the session's next seq: anything said from it on came after the stop.
  const last = seq - 1
  if (!(state.consent instanceof Map)) state.consent = new Map()
  const id = `${task.id}:${key}`
  const asked = state.consent.get(id)
  if (asked?.granted) return { granted: true, source: asked.granted }
  if (!asked) {
    state.consent.set(id, { seq: last })
    return { granted: false }
  }
  const reply = repliesAfter(agent, asked.seq).at(-1)
  if (!reply) return { granted: false, waiting: true }
  if (REFUSAL.test(reply.text)) {
    asked.seq = last
    return { granted: false, refused: reply.text }
  }
  asked.granted = { seq: reply.seq, via: reply.via, quote: reply.text }
  return { granted: true, source: asked.granted }
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
  return repliesAfter(agent, task?.startedSeq ?? -1).some(reply => {
    const text = reply.text.replace(/\s+/g, ' ').trim()
    return !/^\/dsh-auto-dev\b/.test(text) && text !== request && !(request && (text.endsWith(request) || request.endsWith(text)))
  })
}
