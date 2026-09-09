import { describe, expect, it } from "vitest";
import { toCodexModel } from "../../src/shared/utils/codexModelCatalog.js";

describe("Codex model catalog service tiers", () => {
  it("advertises Fast/Priority for Codex models", () => {
    const model = toCodexModel({
      id: "cx/gpt-5.6-luna",
      capabilities: { reasoning: true },
      context_length: 258400,
    });

    expect(model.service_tiers).toEqual([
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ]);
    expect(model.additional_speed_tiers).toEqual(["fast"]);
    expect(model.default_service_tier).toBeNull();
  });

  it("does not advertise Codex speed tiers for other providers", () => {
    const model = toCodexModel({
      id: "cc/claude-sonnet-5",
      capabilities: { reasoning: true },
      context_length: 200000,
    });

    expect(model.service_tiers).toEqual([]);
    expect(model.additional_speed_tiers).toEqual([]);
  });

  it("does not advertise unsupported tiers for Codex models", () => {
    const model = toCodexModel({
      id: "cx/gpt-5.4-mini",
      capabilities: { reasoning: true },
      context_length: 272000,
    });

    expect(model.service_tiers).toEqual([]);
    expect(model.additional_speed_tiers).toEqual([]);
    expect(model.default_service_tier).toBeNull();
  });
});
