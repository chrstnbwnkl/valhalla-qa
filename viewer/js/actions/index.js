// Action modules. Each one knows how differences are evaluated and shown for one valhalla action:
//
//   detailed      true if it has a dedicated comparison (shown on the front page)
//   rawInMain     true if renderDetail already shows the raw responses (otherwise the sidebar lists them)
//   flags         {key: {sev, label, style}} change flags it may set, sev 0..5, style hot|solid|line|dim
//   classify(i)   -> {flags, magnitude, metrics} from the item's summary.json entry
//   kinds         [{key, label, test(item)}] extra filters for the action table
//   columns       [{label, width, cls, render(item)}] extra columns for the action table
//   sorts         [{key, label, cmp(x, y)}] extra sort orders
//   renderDetail(ctx)  fills ctx.side (sidebar section) and ctx.main (main area, kept per module)
//   onKey(e)      optional keyboard handling in the detail view, return true if handled
//
// Actions without a module of their own use the generic json diff.
import generic from './generic.js';
import route from './route.js';

const MODULES = { route };

export function moduleFor(action) {
  return MODULES[action] || generic;
}
