#!/usr/bin/env node
/**
 * Test entry point.
 *
 * Runs the strict typecheck and the acceptance self-check (determinism,
 * persistence, validation, offline LLM fallbacks, replay verification).
 * Exits non-zero on any failure so CI can gate on it.
 */
import { spawnSync } from 'node:child_process';

const steps = [
  { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit', '-p', 'tsconfig.json'] },
  { name: 'acceptance selfcheck', cmd: 'npx', args: ['tsx', 'packages/sim/src/cli.ts', 'selfcheck'] },
];

let failed = 0;
for (const step of steps) {
  process.stdout.write(String.fromCharCode(10) + '=== ' + step.name + ' ===' + String.fromCharCode(10));
  const res = spawnSync(step.cmd, step.args, { stdio: 'inherit', cwd: process.cwd() });
  if (res.status !== 0) {
    console.error('FAILED: ' + step.name + ' exit=' + res.status);
    failed += 1;
  }
}

const NL = String.fromCharCode(10);
process.stdout.write(NL + (failed === 0 ? 'ALL CHECKS PASSED' : failed + ' STEP(S) FAILED') + NL);
process.exit(failed === 0 ? 0 : 1);
