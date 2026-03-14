#!/usr/bin/env node
import { getConfig } from './config.js';
import { run } from './run.js';
import { llmHealth } from './presenter.js';
import { getBackendManager } from './executor.js';

const args = process.argv.slice(2);
const cfg = getConfig();

if (args[0] === 'health') {
  const llm = await llmHealth(cfg);
  const sandbox = getBackendManager().sandbox?.health?.() || { available: false, reason: 'sandbox backend not initialized' };
  console.log(JSON.stringify({ llm, sandbox }, null, 2));
  process.exit(0);
}

if (args[0] === 'run') {
  const command = args.slice(1).join(' ');
  if (!command) {
    console.error('usage: node src/cli.js run <command>');
    process.exit(2);
  }
  const result = await run(command, cfg, {
    confirmDelete: args.includes('--confirm-delete'),
    confirmExternalSend: args.includes('--confirm-external'),
    confirmWrite: args.includes('--confirm-write'),
    confirmSure: args.includes('--confirm-sure')
  });
  console.log(result.output);
  process.exit(result.exitCode);
}

console.log('local-ai-harness CLI');
console.log('  node src/cli.js run <command> [--confirm-write] [--confirm-delete] [--confirm-external] [--confirm-sure]');
console.log('  # includes dom + llm commands, e.g. dom --file page.html query "a" --top 5 --text');
console.log('  node src/cli.js health');
