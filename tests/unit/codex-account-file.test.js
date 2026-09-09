import { describe, expect, it } from "vitest";
import {
  hasCodexTokenPair,
  parseCodexAccountFile,
} from "../../src/shared/utils/codexAccountFile.js";

describe("shared Codex account file format", () => {
  it("parses the Import JSON sample for credential-based Auto Login", () => {
    const parsed = parseCodexAccountFile(JSON.stringify({
      "2fa": "SECRET",
      OPENAI_API_KEY: null,
      email: "user@example.com",
      last_refresh: "2026-09-01T00:00:00Z",
      password: "password",
      tokens: {
        access_token: "access",
        account_id: "account",
        id_token: "id",
        refresh_token: "refresh",
      },
    }));

    expect(parsed.errors).toEqual([]);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toEqual(expect.objectContaining({
      email: "user@example.com",
      password: "password",
      totpSecret: "SECRET",
    }));
    expect(hasCodexTokenPair(parsed.records[0])).toBe(true);
  });

  it("parses exported pretty adjacent records and preserves token-only accounts", () => {
    const record = (email) => JSON.stringify({
      "2fa": null,
      OPENAI_API_KEY: null,
      email,
      last_refresh: "2026-09-01T00:00:00Z",
      password: null,
      tokens: {
        access_token: `access-${email}`,
        account_id: `account-${email}`,
        id_token: `id-${email}`,
        refresh_token: `refresh-${email}`,
      },
    }, null, 2);
    const parsed = parseCodexAccountFile(`${record("one@example.com")}\n${record("two@example.com")}`);

    expect(parsed.errors).toEqual([]);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records.every((account) => hasCodexTokenPair(account))).toBe(true);
    expect(parsed.records.every((account) => account.password === "")).toBe(true);
  });

  it("reports records that have neither credentials nor a token pair", () => {
    const parsed = parseCodexAccountFile(JSON.stringify({ email: "missing@example.com" }));

    expect(parsed.records).toEqual([]);
    expect(parsed.errors[0].error).toContain("password or tokens");
  });
});
