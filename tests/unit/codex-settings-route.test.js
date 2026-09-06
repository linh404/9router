import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTOML } from "confbox";

const originalHome = process.env.HOME;
const tempHomes = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = originalHome;
  for (const tempHome of tempHomes.splice(0)) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

describe("Codex settings route", () => {
  it("preserves provider auth and writes native reasoning settings", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "9router-codex-settings-"));
    tempHomes.push(tempHome);
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    const codexDir = path.join(tempHome, ".codex");
    fs.mkdirSync(codexDir);
    fs.writeFileSync(path.join(codexDir, "config.toml"), [
      'model = "old-model"',
      'model_provider = "9router"',
      "",
      "[model_providers.9router]",
      'name = "9Router"',
      'base_url = "http://old/v1"',
      'wire_api = "responses"',
      "",
      "[model_providers.9router.auth]",
      'command = "python3"',
      'args = ["-c", "print(\\\"preserve-me\\\")"]',
    ].join("\n"));

    const { POST } = await import("../../src/app/api/cli-tools/codex-settings/route.js");
    const response = await POST(new Request("http://localhost/api/cli-tools/codex-settings", {
      method: "POST",
      body: JSON.stringify({
        baseUrl: "http://127.0.0.1:20128/v1",
        apiKey: "test-key",
        model: "cx/gpt-5.6-luna",
        subagentModel: "cx/gpt-5.6-luna",
        reasoningEffort: "high",
        serviceTier: "priority",
      }),
    }));

    expect(response.status).toBe(200);
    const config = parseTOML(fs.readFileSync(path.join(codexDir, "config.toml"), "utf8"));
    expect(config.model).toBe("cx/gpt-5.6-luna");
    expect(config.model_reasoning_effort).toBe("high");
    expect(config.service_tier).toBe("priority");
    expect(config.agents.default_subagent_model).toBe("gpt-5.6-luna");
    expect(config.agents.default_subagent_reasoning_effort).toBe("high");
    expect(config.model_providers["9router"].auth.command).toBe("python3");
    expect(config.model_providers["9router"].http_headers.Authorization).toMatch(/^Bearer /);
    expect(fs.existsSync(path.join(codexDir, "auth.json"))).toBe(false);
  });

  it("removes the subagent reasoning override on reset", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "9router-codex-reset-"));
    tempHomes.push(tempHome);
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    const codexDir = path.join(tempHome, ".codex");
    fs.mkdirSync(codexDir);
    fs.writeFileSync(path.join(codexDir, "config.toml"), [
      'model_provider = "9router"',
      "",
      "[agents]",
      'default_subagent_model = "gpt-5.6-luna"',
      'default_subagent_reasoning_effort = "high"',
    ].join("\n"));

    const { DELETE } = await import("../../src/app/api/cli-tools/codex-settings/route.js");
    const response = await DELETE();

    expect(response.status).toBe(200);
    const config = parseTOML(fs.readFileSync(path.join(codexDir, "config.toml"), "utf8"));
    expect(config.agents?.default_subagent_model).toBeUndefined();
    expect(config.agents?.default_subagent_reasoning_effort).toBeUndefined();
  });
});
