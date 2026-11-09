/**
 * The postmortem knowledge base on the model's own call (src/incidents.mjs): no words
 * lists every entry's title so the model can choose; words return the entries holding
 * them, verbatim. Which entry applies is the model's call. Read-only.
 */
import { INCIDENTS_FILE } from '../facts.mjs'
import { searchIncidents } from '../incidents.mjs'
import { string } from './shared.mjs'

export const workRecall = api => (
  // --------------------------------------------------------------- work_recall
  ['work_recall', `Postmortem knowledge base: this project's ${INCIDENTS_FILE} plus other projects' copies. No query → every entry's title, newest first, to choose from; query (space-separated words) → entries containing them, verbatim, most words matched first. Read-only; whether one applies is your call.`, {
    query: string, limit: { type: 'integer', minimum: 1, maximum: 20 },
  }, [],
  async (args, exec) => ({ file: INCIDENTS_FILE, ...searchIncidents(api.projectOf(exec.agent, ['.']), args.query, args.limit ?? 5) })]
)
