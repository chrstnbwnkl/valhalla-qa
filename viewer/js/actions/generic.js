// Fallback for actions without a dedicated module: side-by-side json with differing lines marked.
import { h, jsonView, copyButton, scrollToNextDiff } from '../util.js';

const body = (file) => (file?.error ? file : file?.response);

export default {
  detailed: false,
  rawInMain: true,

  flags: {
    json: { sev: 1, label: 'json', style: 'line' },
  },

  classify(item) {
    if (item.status !== 'different') return { flags: [], magnitude: 0 };
    const paths = item.entry?.differing_paths || [];
    return { flags: item.flags.length ? [] : ['json'], magnitude: paths.length + (item.entry?.differing_paths_truncated ? 1 : 0) };
  },

  kinds: [],

  columns: [
    {
      label: 'Diff paths',
      width: '110px',
      cls: 'num',
      render: (i) => (i.entry?.differing_paths ? `${i.entry.differing_paths.length}${i.entry.differing_paths_truncated ? '+' : ''}` : ''),
    },
  ],

  sorts: [{ key: 'paths', label: 'Most differing paths', cmp: (x, y) => y.magnitude - x.magnitude }],

  renderDetail(ctx) {
    const { files, main, summary } = ctx;
    const a = body(files.a);
    const b = body(files.b);
    const pane = (run, value, other, present) => {
      const scroller = h('div', { class: 'pane-body' });
      const head = h('div', { class: 'pane-head' }, h('span', { class: `tag ${run}` }, run.toUpperCase()), h('b', null, summary[run]));
      if (present) {
        const pre = jsonView(value, other, files.a && files.b);
        scroller.append(pre);
        const diffs = pre.querySelectorAll('.d').length;
        head.append(
          h('span', { class: 'dim' }, `${diffs} differing lines`),
          h('span', { class: 'grow' }),
          diffs ? h('button', { class: 'btn small', onclick: () => scrollToNextDiff(scroller, pre) }, 'Next diff ↓') : null,
          copyButton(() => JSON.stringify(value, null, 2)),
        );
      } else {
        scroller.append(h('div', { class: 'empty' }, `No response in ${summary[run]}.`));
      }
      return h('div', { class: 'pane' }, head, scroller);
    };
    main.replaceChildren(h('div', { class: 'panes' },
      pane('a', a, b, Boolean(files.a)),
      pane('b', b, a, Boolean(files.b))));
  },
};
