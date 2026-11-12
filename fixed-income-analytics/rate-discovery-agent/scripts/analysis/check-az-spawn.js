'use strict';
const { spawnSync } = require('child_process');

const AZ = process.env.AZ_BIN;
const args = ['account', 'show', '--query', 'name', '-o', 'tsv'];

function tryIt(label, opts) {
  const o = { encoding: 'utf-8', ...opts };
  const r = spawnSync(o._cmd, o._args, o);
  console.log(`[${label}] status=${r.status} stdout=${JSON.stringify((r.stdout||'').trim())} stderr=${JSON.stringify((r.stderr||'').trim().slice(0,160))}`);
}

const q = (s) => `"${s}"`;
const argline = args.map((a) => (/\s/.test(a) ? q(a) : a)).join(' ');

// A: shell:true, raw path with spaces
tryIt('A shell:true raw', { _cmd: AZ, _args: args, shell: true });

// B: shell:true, manually-quoted command in args (Node concatenates with space)
tryIt('B shell:true args[0]=quoted', { _cmd: q(AZ), _args: args, shell: true });

// C: cmd.exe /d /s /c "<exe>" args... with verbatim
const C = `${q(AZ)} ${argline}`;
tryIt('C cmd.exe /d /s /c verbatim', { _cmd: 'cmd.exe', _args: ['/d', '/s', '/c', C], windowsVerbatimArguments: true });

// D: cmd.exe /d /c with verbatim (no /s)
tryIt('D cmd.exe /d /c verbatim', { _cmd: 'cmd.exe', _args: ['/d', '/c', C], windowsVerbatimArguments: true });

// E: cmd.exe /d /s /c "<entire-quoted-cmdline>" verbatim — outer quotes around whole thing
const E = `"${q(AZ)} ${argline}"`;
tryIt('E cmd.exe /d /s /c outer-quote', { _cmd: 'cmd.exe', _args: ['/d', '/s', '/c', E], windowsVerbatimArguments: true });

// F: cmd.exe /c, no verbatim (Node escapes args)
tryIt('F cmd.exe /c node-escaped', { _cmd: 'cmd.exe', _args: ['/c', AZ, ...args] });
