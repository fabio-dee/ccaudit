import { define } from 'gunshi';

export const ghostCommand = define({
  name: 'ghost',
  description: 'Show ghost inventory report (default)',
  args: {
    since: {
      type: 'string',
      short: 's',
      description: 'Time window for ghost detection (e.g., 7d, 30d)',
      default: '7d',
    },
    json: {
      type: 'boolean',
      short: 'j',
      description: 'Output as JSON',
      default: false,
    },
  },
  run(ctx) {
    console.log('ccaudit ghost: not yet implemented');
    console.log(`Options: since=${ctx.values.since}, json=${ctx.values.json}`);
  },
});
