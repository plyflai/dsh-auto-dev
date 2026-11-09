/**
 * Words that teach the model to fill a form: a tool name, an `operation:`, a field
 * name with a colon. A card says what happened and the one thing to do in plain
 * words (设计约定「绝对禁忌」); the tool descriptions own the parameters. Shared by
 * the replay report and the scenario bench, so a live run and the bench judge alike.
 */
export const FILLS = /operation:\s*\w+|\bwork_(start|plan|control|submit|extend|env|status|recall)\b|\b(kind|scope|acceptance|claims|callId|target):|\b(preserve|residue|outcome)\b/g

export const fillsIn = text => [...new Set(String(text ?? '').match(FILLS) ?? [])]
