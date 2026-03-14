import { resolve } from 'node:path';

export function getConfig() {
  const root = process.env.HARNESS_ROOT || process.cwd();
  return {
    root,
    cwd: process.env.HARNESS_CWD || root,
    traceFile: process.env.HARNESS_TRACE_FILE || '/home/bot/harness-logs/run-trace.jsonl',
    auditFile: process.env.HARNESS_AUDIT_FILE || '/home/bot/harness-logs/audit.log',
    artifactDir: process.env.HARNESS_ARTIFACT_DIR || resolve(root, 'artifacts'),
    maxSegments: Number(process.env.HARNESS_MAX_SEGMENTS || 12),
    timeoutMs: Number(process.env.HARNESS_TIMEOUT_MS || 60000),
    maxReturnBytes: Number(process.env.HARNESS_MAX_RETURN_BYTES || 50 * 1024),
    maxLines: Number(process.env.HARNESS_MAX_LINES || 200),
    useLlmPresenter: (process.env.HARNESS_USE_LLM_PRESENTER || '0') === '1',
    llmModel: process.env.HARNESS_LLM_MODEL || 'local-model',
    llmDefaultModel: process.env.HARNESS_LLM_DEFAULT_MODEL || process.env.HARNESS_LLM_MODEL || 'local-model',
    llmEndpoints: (process.env.HARNESS_LLM_ENDPOINTS || 'http://127.0.0.1:8080,http://127.0.0.1:8081').split(',').map((s) => s.trim()).filter(Boolean),
    llmToolsEnabled: (process.env.HARNESS_LLM_TOOLS_ENABLED || '1') === '1',
    llmTimeoutMs: Number(process.env.HARNESS_LLM_TIMEOUT_MS || 12000),
    domEnabled: (process.env.HARNESS_DOM_ENABLED || '1') === '1',
    domActEnabled: (process.env.HARNESS_DOM_ACT_ENABLED || '0') === '1'
  };
}
