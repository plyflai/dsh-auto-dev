/**
 * A unit may carry `ui: 'static' | 'logic' | 'browser' | false` — a label the
 * person or the model wrote. The plugin no longer reads commands to decide which
 * tier "ran" (设计约定「第三条路」): whether a screen needs a browser is the
 * model's call, said at hand-in as a conditional sentence (src/craft.mjs).
 */
export const UI_TIERS = ['static', 'logic', 'browser']
