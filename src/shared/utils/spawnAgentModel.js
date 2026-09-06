import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";

const PROVIDER_ALIAS_TOKENS = new Set([
  ...Object.keys(PROVIDER_ID_TO_ALIAS),
  ...Object.values(PROVIDER_ID_TO_ALIAS),
]);

/**
 * Codex multi-agent spawn_agent only accepts bare model IDs from its collab
 * catalog — a provider-prefixed value ("cx/gpt-5.6-luna") is rejected with
 * "Unknown model". Strip a leading known provider alias/id prefix; 9router
 * resolves the bare ID back to the owning provider at request time.
 */
export function toSpawnAgentModelId(value) {
  const model = String(value || "").trim();
  const slash = model.indexOf("/");
  if (slash <= 0) return model;
  const prefix = model.slice(0, slash);
  return PROVIDER_ALIAS_TOKENS.has(prefix) ? model.slice(slash + 1) : model;
}
