/**
 * The only two ways a work_* call may stop (设计约定「门禁定义」).
 *
 * `GateError` is one of the four gates the user signed off: G1 交付诚实, G2 破坏性操作,
 * G3 用户禁令, G4 复盘落盘. It names one rule and one passing action, and the plugin decides it from
 * its own facts (log, git, the user's words), never from what the model declared.
 *
 * `invariant` is the plugin's own records or state machine being broken. It is never
 * the model's fault and never a refusal of what the model asked for.
 *
 * Everything else a call gets wrong — a missing field, a wrong shape, a paragraph where
 * a list was expected, a name that does not exist — is digested: a default, a dropped
 * item, or a plain answer saying what exists. tests/gate.test.mjs counts every other
 * `throw` under src/ and fails the check bench when one appears.
 */
export const GATES = Object.freeze({ G1: '交付诚实', G2: '破坏性操作', G3: '用户禁令', G4: '复盘落盘' })

export class InvariantError extends Error {}

export class GateError extends Error {
  constructor(gate, rule, action) {
    invariant(Object.hasOwn(GATES, gate), `unknown gate ${gate}`)
    super(action ? `${rule}\n过关：${action}` : rule)
    this.gate = gate
  }
}

export function invariant(ok, message) {
  if (!ok) throw new InvariantError(`dsh-auto-dev: ${message}`)
}
