/**
 * What the host owes a conversation between steps: notices queued by tools,
 * receipts queued by the command, the request a command could not hand over, and
 * the one start grant a person's command issues. All of it is in memory on
 * purpose — none of it may come back after a restart.
 */
import { randomUUID } from 'node:crypto'
import { lossless } from './json.mjs'
import { lastStartCommand } from './said.mjs'

const CONTEXT_SUMMARY_MAX_CHARS = 120

/** The `source.kind` every queued notice carries; the browser half claims cards by it. */
export const NOTICE_KIND = 'dsh-auto-dev'

export function createMailbox({ sessionState, sessionId, openedSince = () => undefined }) {
  const intake = new Map()
  // Hooks: observe what ran. The user's own words are captured here because
  // authorizations and requests must always be quotable, never paraphrased.
  //
  // Every notice below is a `notice`-form context attached to the step it
  // belongs to: the model sees it once, the durable log keeps the one-line
  // summary, and nothing here can veto a call. "Observe and enrich, never veto"
  // is the whole contract of this half of the plugin.
  /**
   * One notice, two audiences: `body` is what the model reads (one line), and
   * `form` + `data` are what the conversation draws (a card or a badge row).
   * The UI never has to parse the sentence back apart.
   */
  const notice = (body, summary, extra = {}) => Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: body })]),
    source: Object.freeze({
      kind: NOTICE_KIND,
      form: extra.form ?? 'notice',
      summary: summary.slice(0, CONTEXT_SUMMARY_MAX_CHARS),
      ...(extra.data ? { data: Object.freeze(lossless(extra.data)) } : {}),
    }),
  })
  // Tools cannot post messages themselves; they queue what happened and the
  // post-execute hook hands it to the host in the same step.
  const outbox = agent => {
    const state = sessionState(agent)
    if (!Array.isArray(state.outbox)) state.outbox = []
    return state.outbox
  }
  const queueNotice = (agent, body, summary, extra) => {
    if (!agent) return
    outbox(agent).push(notice(body, summary, extra))
  }
  // One line for a call the plugin stopped, once per rule per task: the person
  // sees that a gate fired and what happens next, without a line per retry.
  const blocked = new Set()
  const blockedOnce = (agent, key, { unit, title, line }) => {
    if (!agent || blocked.has(key)) return
    blocked.add(key)
    queueNotice(agent, `**${title}** — ${line}`, `dsh-auto-dev blocked ${key}`,
      { form: 'blocked-call', data: { ...(unit ? { unit } : {}), title, line, tone: 'guard' } })
  }
  const takeOutbox = agent => (agent ? outbox(agent).splice(0) : [])

  /**
   * A receipt the command owes the conversation.
   *
   * The outbox belongs to tool calls (drained in post-execute). A command has no
   * tool call to hang a card on, and its own return value never reaches the
   * conversation — so the notice waits here and rides the next pre-step.
   */
  const queueReceipt = (agent, message) => {
    const state = sessionState(agent)
    if (!Array.isArray(state.receipts)) state.receipts = []
    state.receipts.push(message)
  }
  const takeReceipts = agent => sessionState(agent).receipts?.splice(0) ?? []

  // Slash commands and hooks share this one map: a command writes, the next
  // pre-step reads and clears it. In memory on purpose — a request nobody sent is
  // not a task, and it must not come back after a restart as one.
  const takeIntake = agent => {
    const id = sessionId(agent)
    const pending = intake.get(id)
    if (pending) intake.delete(id)
    return pending
  }

  // One grant per user-issued start: the command writes it, work_start spends it.
  // It lives until spent or replaced by the next start, in this session's memory
  // only: registration now waits until the request is clear (F-clarify 6b), and
  // the person may take a while to answer the question that clears it.
  const grantStart = (agent, text, { auto = false } = {}) => {
    const state = sessionState(agent)
    const seq = agent?.session?.seq
    state.startGrant = { text: String(text ?? '').trim(), at: Date.now(), seq: typeof seq === 'number' ? seq : 0, auto: auto === true }
    state.startSpent = undefined
    state.startHinted = false
  }
  /**
   * Hints and registration must agree on whether the person's grant is valid.
   * Reading it does not spend the one start; only work_start does that.
   */
  const readStartGrant = agent => {
    const state = sessionState(agent)
    // After a host restart memory is empty; the person's start command is still in the log.
    if (!state.startGrant && !state.startSpent) {
      const command = lastStartCommand(agent?.session)
      if (command) {
        const taskId = openedSince(agent, command.seq)
        if (taskId) state.startSpent = { taskId, seq: command.seq }
        else state.startGrant = { text: command.text, at: Date.now(), seq: command.seq, auto: command.auto }
      }
    }
    const { startGrant: grant, startSpent: spent } = state
    // Spent is not the same fact as never started: the start opened a task here already.
    if (!grant && spent) return { ok: false, spent, reason: `这次对话的 start 已经登记过任务 ${spent.taskId}` }
    if (!grant) return { ok: false, reason: 'nobody has run /dsh-auto-dev start in this conversation yet' }
    return { ok: true, text: grant.text, seq: grant.seq ?? 0, auto: grant.auto === true }
  }
  const consumeStartGrant = (agent, taskId) => {
    const verdict = readStartGrant(agent)
    const state = sessionState(agent)
    if (state.startGrant) state.startSpent = { taskId, seq: state.startGrant.seq }
    state.startGrant = undefined
    return verdict
  }

  // The person's autopilot switch before the task is registered (it moves onto the record then).
  const setGrantAuto = (agent, auto) => {
    const grant = sessionState(agent).startGrant
    if (!grant) return false
    grant.auto = auto === true
    return true
  }

  return { setGrantAuto, notice, queueNotice, blockedOnce, takeOutbox, queueReceipt, takeReceipts, intake, takeIntake, grantStart, readStartGrant, consumeStartGrant }
}
