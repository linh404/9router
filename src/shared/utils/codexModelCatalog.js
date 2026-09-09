import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";

const CODEX_REASONING_DESCRIPTIONS = {
  minimal: "Fast responses with minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
  ultra: "Maximum reasoning with automatic task delegation",
};

// Codex CLI uses the richer `models` catalog to decide whether a configured
// service tier is actually available for the selected model. Keep the legacy
// `fast` marker for older clients and expose the current `priority` tier for
// clients that understand structured service-tier metadata.
const CODEX_SERVICE_TIERS = [
  {
    id: "priority",
    name: "Fast",
    description: "1.5x speed, increased usage",
  },
];

// Codex does not expose Fast/Priority for every model. Keep this allowlist
// aligned with the CLI catalog; unknown/new models stay conservative until
// their tier support is confirmed. Review variants inherit their base model's
// service-tier support.
const CODEX_PRIORITY_MODEL_IDS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
]);

const PROVIDER_ALIAS_TO_ID = Object.fromEntries(
  Object.entries(PROVIDER_ID_TO_ALIAS).map(([providerId, alias]) => [alias, providerId]),
);

// Codex expects its richer model catalog under `models`; keep `data` as the
// standard OpenAI-compatible catalog for every other client.
export const toCodexModel = (model) => {
  const [alias, ...modelParts] = String(model?.id || "").split("/");
  const modelId = modelParts.join("/") || alias;
  const providerId = PROVIDER_ALIAS_TO_ID[alias] || alias;
  const levels = model?.capabilities?.reasoning
    ? (getThinkingLevels(providerId, modelId) || [])
    : [];
  const supportedReasoningLevels = levels
    .filter((level) => level !== "none")
    .map((effort) => ({ effort, description: CODEX_REASONING_DESCRIPTIONS[effort] || `${effort} reasoning` }));
  const defaultReasoningLevel = levels.includes("medium")
    ? "medium"
    : (supportedReasoningLevels[0]?.effort || "none");
  const isCodexModel = providerId === "codex";
  const baseModelId = modelId.replace(/-review$/, "");
  const supportsPriority = isCodexModel && CODEX_PRIORITY_MODEL_IDS.has(baseModelId);

  return {
    slug: model.id,
    display_name: model.id,
    description: `${model.id} via 9Router`,
    default_reasoning_level: defaultReasoningLevel,
    supported_reasoning_levels: supportedReasoningLevels,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    additional_speed_tiers: supportsPriority ? ["fast"] : [],
    service_tiers: supportsPriority ? CODEX_SERVICE_TIERS.map((tier) => ({ ...tier })) : [],
    ...(isCodexModel ? { default_service_tier: null } : {}),
    availability_nux: null,
    upgrade: null,
    base_instructions: "You are Codex, an AI coding assistant.",
    model_messages: {},
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_image_detail_original: model.capabilities?.vision === true,
    context_window: model.context_length,
    max_context_window: model.context_length,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: model.capabilities?.vision === true ? ["text", "image"] : ["text"],
    supports_search_tool: model.capabilities?.search === true,
    use_responses_lite: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    tool_mode: "code_mode_only",
    multi_agent_version: "v2",
  };
};
