/**
 * Whether the request is too thin to build from, and why.
 *
 * The question is never "is this hard" — it is "would two people build different
 * things from this sentence". A short request with no acceptance does that; so
 * does anything touching money, permissions or another system. A long request
 * that says what done means is ready, however big it is.
 *
 * Pure on purpose: the host decides in `work_start`, before the model has a
 * chance to talk itself out of asking.
 */

export const CLARIFY_LIMIT = 3

const ACCEPTANCE_WORDS = ['验收', '完成标准', '算完成', 'acceptance']
const RISK_WORDS = ['权限', '金额', '支付', '状态流', '外部系统', '迁移', '不可逆', '合规']

/**
 * What to ask when the request is thin. Business only: a fact is read from the
 * code or the project record, a technical choice belongs to the model.
 */
export const CLARIFY_QUESTIONS = [
  '业务口径：这件事对谁生效，什么算做成？',
  '边界：哪些情况明确不做？',
  '验收样本：给我一个真实的例子（谁、做什么、看到什么）',
]

export function needsClarify({ request, mode } = {}) {
  if (mode === 'look') return { needed: false, reasons: [] }
  const value = typeof request === 'string' ? request : ''
  if (value.trim() === '') return { needed: false, reasons: [] }
  const reasons = []
  const compact = value.replace(/\s+/g, '')
  const statesAcceptance = ACCEPTANCE_WORDS.some(word => value.includes(word))
  if (compact.length <= 40 && !statesAcceptance) reasons.push('需求很短，没说清什么算完成')
  if (mode === 'build') reasons.push('多步交付，先把口径定下来再拆单元')
  const risky = RISK_WORDS.filter(word => value.includes(word))
  if (risky.length) reasons.push(`碰到风险面：${risky.join(' / ')}`)
  return { needed: reasons.length > 0, reasons }
}

/**
 * The brief that goes back with `work_start`: what to ask, how many, and what to
 * do when the person does not answer. Questions already asked are left out — a
 * model that re-asks the same thing is not clarifying, it is stalling.
 */
export function clarifyBrief(task) {
  const asked = Array.isArray(task?.clarify?.asked) ? task.clarify.asked : []
  const already = asked.map(row => (typeof row?.q === 'string' ? row.q : '')).filter(Boolean)
  return {
    ask: CLARIFY_QUESTIONS.filter(question => !already.includes(question)),
    rule: '只澄清会改变实现或验收的业务歧义。事实自己查，技术自己定。能安全继续时说明假设；确实缺决策时问一个核心问题。记录可选，不构成开工前提。',
    ...(already.length ? { asked: already } : {}),
  }
}
