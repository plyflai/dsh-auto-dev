/**
 * What the host owes a conversation between steps: notices queued by tools,
 * receipts queued by the command, the request a command could not hand over, and
 * the one start grant a person's command issues. All of it is in memory on
 * purpose — none of it may come back after a restart.
 */
import { randomUUID } from 'node:crypto'
import { lossless } from './json.mjs'

const CONTEXT_SUMMARY_MAX_CHARS = 120

/** The `source.kind` every queued notice carries; the browser half claims cards by it. */
export const NOTICE_KIND = 'auto-dev-v3'

export function createMailbox({ sessionState, sessionId }) {
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
    queueNotice(agent, `**${title}** — ${line}`, `auto-dev-v3 blocked ${key}`,
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
  // Short-lived on purpose — a grant is about this intent, not a permission that
  // lingers; a model that fumbles the call asks again instead of inheriting a blank.
  const START_GRANT_TTL_MS = 15 * 60 * 1000
  const grantStart = (agent, text) => {
    const state = sessionState(agent)
    state.startGrant = { text: String(text ?? '').trim(), at: Date.now() }
    state.startHinted = false
  }
  /**
   * Hints and registration must agree on whether the person's grant is valid.
   * Reading it does not spend the one start; only work_start does that.
   */
  const readStartGrant = agent => {
    const grant = sessionState(agent).startGrant
    if (!grant) return { ok: false, reason: 'nobody has run /dsh-auto-dev start in this conversation yet' }
    if (Date.now() - (Number(grant.at) || 0) > START_GRANT_TTL_MS) {
      return { ok: false, reason: 'the start grant from that command expired (15 minutes) — ask the person to run it again; the words are theirs, not yours' }
    }
    return { ok: true, text: grant.text }
  }
  const consumeStartGrant = agent => {
    const verdict = readStartGrant(agent)
    sessionState(agent).startGrant = undefined
    return verdict
  }

  return { notice, queueNotice, blockedOnce, takeOutbox, queueReceipt, takeReceipts, intake, takeIntake, grantStart, readStartGrant, consumeStartGrant }
}
