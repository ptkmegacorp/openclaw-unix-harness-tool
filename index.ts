import { resolve } from "node:path";

function buildCfg(root: string, overrides: any = {}) {
  return {
    root,
    cwd: overrides.cwd || process.env.HARNESS_CWD || root,
    traceFile: overrides.traceFile || process.env.HARNESS_TRACE_FILE || "/home/bot/harness-logs/run-trace.jsonl",
    auditFile: overrides.auditFile || process.env.HARNESS_AUDIT_FILE || "/home/bot/harness-logs/audit.log",
    artifactDir: overrides.artifactDir || process.env.HARNESS_ARTIFACT_DIR || resolve(root, "artifacts"),
    maxSegments: Number(overrides.maxSegments ?? process.env.HARNESS_MAX_SEGMENTS ?? 12),
    timeoutMs: Number(overrides.timeoutMs ?? process.env.HARNESS_TIMEOUT_MS ?? 60000),
    maxReturnBytes: Number(overrides.maxReturnBytes ?? process.env.HARNESS_MAX_RETURN_BYTES ?? 50 * 1024),
    maxLines: Number(overrides.maxLines ?? process.env.HARNESS_MAX_LINES ?? 200),
    useLlmPresenter: Boolean(overrides.useLlmPresenter ?? ((process.env.HARNESS_USE_LLM_PRESENTER || "0") === "1")),
    llmModel: overrides.llmModel || process.env.HARNESS_LLM_MODEL || "local-model",
    llmEndpoints: Array.isArray(overrides.llmEndpoints)
      ? overrides.llmEndpoints
      : (process.env.HARNESS_LLM_ENDPOINTS || "http://127.0.0.1:8080,http://127.0.0.1:8081").split(",").map((s) => s.trim()).filter(Boolean),
    domEnabled: String(overrides.domEnabled ?? process.env.HARNESS_DOM_ENABLED ?? "1") === "1"
  };
}

export default function register(api: any) {
  const pluginCfg = (api?.config?.plugins?.entries?.["openclaw-unix-harness-tool"]?.config) || {};
  const root = pluginCfg.root || "/home/bot/openclaw-unix-harness-tool";

  api.registerTool({
    name: "openclaw_unix_harness_run",
    description:
      "Run unix-style command chains via local harness (supports |, &&, ||, ;). Class B/C commands require explicit flags and confirmSure=true (are-you-sure double-check).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string", minLength: 1 },
        confirmWrite: { type: "boolean", default: false },
        confirmDelete: { type: "boolean", default: false },
        confirmExternalSend: { type: "boolean", default: false },
        confirmSure: { type: "boolean", default: false }
      },
      required: ["command"]
    },
    async execute(_id: string, params: any) {
      try {
        const mod = await import("file:///home/bot/openclaw-unix-harness-tool/src/run.js");
        const cfg = buildCfg(root, pluginCfg);
        const result = await mod.run(params.command, cfg, {
          confirmWrite: Boolean(params.confirmWrite),
          confirmDelete: Boolean(params.confirmDelete),
          confirmExternalSend: Boolean(params.confirmExternalSend),
          confirmSure: Boolean(params.confirmSure)
        });
        const payload = JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text: payload }] };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error: String(err?.message || err)
                },
                null,
                2
              )
            }
          ]
        };
      }
    }
  });

  api.registerTool({
    name: "openclaw_unix_harness_health",
    description: "Check local llama presenter endpoint health for harness.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {}
    },
    async execute() {
      try {
        const mod = await import("file:///home/bot/openclaw-unix-harness-tool/src/presenter.js");
        const cfg = buildCfg(root, pluginCfg);
        const health = await mod.llmHealth(cfg);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, health }, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err?.message || err) }, null, 2) }] };
      }
    }
  });
}
