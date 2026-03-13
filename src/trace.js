import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function writeTrace(path, row) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + '\n', 'utf8');
}
