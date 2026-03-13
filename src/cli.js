#!/usr/bin/env node
import { getConfig } from './config.js';
import { run } from './run.js';
import { llmHealth } from './presenter.js';

const args = process.argv.slice(2);
const cfg = getConfig();

if (args[0] === 'health') {
  const h = await llmHealth(cfg);
  console.log(JSON.stringify(h, null, 2));
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
    confirmExternalSend: args.includes('--confirm-external')
  });
  console.log(result.output);
  process.exit(result.exitCode);
}

console.log('local-ai-harness CLI');
console.log('  node src/cli.js run <command>');
console.log('  node src/cli.js health');
