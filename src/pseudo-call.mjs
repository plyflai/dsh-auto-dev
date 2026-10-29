/**
 * A tool call that never became a call.
 *
 * A provider parses a call only when the name is one the request declared. Under
 * the `ptc` collapse that list holds just `run_code` — so a model that reaches for
 * `work_status` directly streams the call as prose instead: the model believes it
 * acted, no tool runs, and the turn settles as if the work were finished. Two
 * shapes arrive that way, Qwen's `<tool_call><function=…>` XML and the older
 * `<tool_call>{json}</tool_call>`, and both are readable back out of the log.
 *
 * This module has no host dependencies: a session log is only ever asked for
 * `seq` and `eventAt`, which is what the rest of this bundle already uses.
 */

/** The textual trace of a call that was never made. */
export const PSEUDO_CALL = /<tool_call\b|<function=/

function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text) {
  try { return JSON.parse(text) } catch { return undefined }
}

/** The text blocks of one assistant message, joined in order. */
export function assistantText(message) {
  const parts = Array.isArray(message?.content) ? message.content : []
  return parts
    .filter(part => part?.type === 'text' && typeof part?.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim()
}

/**
 * `<parameter=name>value</parameter>` pairs, JSON-decoded when the value is JSON.
 *
 * The closing tag is optional: a truncated stream (the case this module exists
 * for) ends mid-block, and the value up to the next tag is still the best copy.
 */
function parameters(text) {
  const out = {}
  const pattern = /<parameter=([\w.-]+)>([\s\S]*?)(?:<\/parameter>|<\/function>|<\/tool_call>|$)/g
  for (const match of String(text).matchAll(pattern)) {
    const decoded = parseJson(match[2])
    out[match[1]] = decoded === undefined ? match[2].trim() : decoded
  }
  return out
}

/**
 * The call the prose describes, or null when this message is ordinary text.
 *
 * `name` is '' when the shape is right but the name was unreadable; the caller
 * still rescues the turn, because the call was lost either way.
 */
export function pseudoCallOf(message) {
  const text = typeof message === 'string' ? message : assistantText(message)
  if (!PSEUDO_CALL.test(text)) return null
  // `<tool_call>{"name":"…","arguments":{…}}</tool_call>` — a JSON body.
  const body = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/.exec(text)
  if (body) {
    const parsed = parseJson(body[1])
    if (parsed) {
      const args = parsed.arguments ?? parsed.parameters ?? parsed.args
      return {
        name: typeof parsed.name === 'string' ? parsed.name : '',
        arguments: plainObject(args) ? args : {},
      }
    }
  }
  // `<function=[group=]name>` — the `tools=` prefix is a provider grouping
  // artifact, not part of the name.
  const named = /<function=(?:[\w.-]+=)?([\w.:-]+)>/.exec(text)
  const args = parameters(text)
  const keys = Object.keys(args)
  // `<parameter=args>{"taskId":…}</parameter>` carries the argument object one
  // level too deep; the model's intent is the object inside.
  const inner = keys.length === 1 && keys[0] === 'args' && plainObject(args.args) ? args.args : args
  return { name: named?.[1] ?? '', arguments: inner }
}

/**
 * The newest assistant message in the log, whichever turn it belongs to.
 *
 * The newest message is the right frame of reference, not the turn: a turn can
 * run a dozen real calls and still lose the last one to prose (session f40c042c
 * did exactly that — real `run_code` calls through step 7, a `read` call that
 * arrived as text, then a step that only repeated the text and ended the turn).
 * Counting calls over the whole turn would have called that turn healthy.
 *
 * Read backwards from the newest event, so a long conversation costs the length
 * of the turn, not the length of the file.
 */
export function newestAssistant(session) {
  const total = Number(session?.seq ?? 0)
  if (typeof session?.eventAt !== 'function' || !Number.isFinite(total) || total <= 0) return null
  for (let at = total - 1; at >= 0; at -= 1) {
    const event = session.eventAt(at)
    if (!event || typeof event !== 'object') continue
    if (event.type !== 'assistant/message') continue
    const data = event.data ?? {}
    const message = data.message ?? {}
    const callNames = (Array.isArray(message.content) ? message.content : [])
      .filter(part => part?.type === 'tool-call')
      .map(part => part.name)
    return { turn: data.turn ?? 0, step: data.step ?? 0, text: assistantText(message), callNames }
  }
  return null
}

/** The newest assistant message, when it belongs to `turn`; null otherwise. */
export function lastAssistant(session, turn) {
  const newest = newestAssistant(session)
  return newest && newest.turn === turn ? newest : null
}

/**
 * Did a real `tool/call` land after `afterStep` in this turn?
 *
 * This is the loop bound. A correction is only worth making while the model is
 * still making progress; if it answers a correction with more prose and no call,
 * a second correction would be the same sentence twice.
 */
export function callsSince(session, turn, afterStep) {
  const total = Number(session?.seq ?? 0)
  if (typeof session?.eventAt !== 'function' || !Number.isFinite(total) || total <= 0) return false
  for (let at = total - 1; at >= 0; at -= 1) {
    const event = session.eventAt(at)
    if (!event || typeof event !== 'object') continue
    const data = event.data ?? {}
    // Bookkeeping events (`agent/inbox/spliced`, results) carry no step; skipping
    // them is what makes the scan reach the newest `tool/call` instead of stopping
    // on whatever event happened to be last.
    if (data.turn !== turn) {
      if (event.type === 'turn/start' && typeof data.turn === 'number') return false
      continue
    }
    if (event.type === 'tool/call') return (data.step ?? 0) > afterStep
  }
  return false
}

/** The turn the log is currently in: the newest `turn/start`, or null. */
export function currentTurn(session) {
  const total = Number(session?.seq ?? 0)
  if (typeof session?.eventAt !== 'function' || !Number.isFinite(total) || total <= 0) return null
  for (let at = total - 1; at >= 0; at -= 1) {
    const event = session.eventAt(at)
    if (!event || typeof event !== 'object') continue
    if (event.type === 'turn/start' && typeof event.data?.turn === 'number') return event.data.turn
  }
  return null
}

/**
 * The one-turn correction: name what was lost, and the call that repairs it.
 *
 * A person reads the notice in the transcript, so it states the failure without
 * blaming them; the model reads it as the next step, so it carries the exact call.
 */
export function rescueMessage(call) {
  const name = String(call?.name ?? '').trim()
  const args = JSON.stringify(call?.arguments ?? {})
  const brief = args.length > 200 ? `${args.slice(0, 197)}…` : args
  const line = name === '' ? `await tools.<工具名>(${brief})` : `await tools.${name}(${brief})`
  return [
    `这一轮你把一次工具调用写成了正文文本（${name || '工具名缺失'}），它没有执行，你手上也还没有它的结果。`,
    `现在用 run_code 真正调用它：${line}。PTC 会话里 run_code 是唯一能直接调的工具，其他工具都要从程序里调；拿到结果后再接着做，不要只回一句「收到」。`,
  ].join('\n')
}
