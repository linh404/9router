/**
 * Shared parser for the Codex account file shape used by the dashboard
 * "Import JSON" flow.
 *
 * Canonical account record:
 * {
 *   "2fa": null,
 *   "OPENAI_API_KEY": null,
 *   "email": "user@example.com",
 *   "last_refresh": "2026-09-01T00:00:00Z",
 *   "password": null,
 *   "tokens": {
 *     "access_token": "...",
 *     "account_id": "...",
 *     "id_token": "...",
 *     "refresh_token": "..."
 *   }
 * }
 *
 * The parser also accepts the older auto-login shape and the legacy Codex
 * wrappers so files can move between Import JSON, Auto Login, and Export JSON
 * without requiring a manual rewrite.
 */

function firstValue(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && String(value).trim()) {
        return String(value).trim();
      }
    }
  }
  return "";
}

function parseJsonValueStream(text) {
  const values = [];
  let offset = 0;

  while (offset < text.length) {
    while (offset < text.length && /\s/.test(text[offset])) offset += 1;
    if (offset >= text.length) break;

    const start = offset;
    const first = text[start];
    if (first !== "{" && first !== "[") {
      throw new Error(`JSON stream must contain objects or arrays (offset ${start})`);
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
        if (depth < 0) break;
      }
    }

    if (end < 0 || inString || depth !== 0) {
      throw new Error(`JSON stream contains an incomplete value (offset ${start})`);
    }
    values.push(JSON.parse(text.slice(start, end)));
    offset = end;
  }

  return values;
}

function appendRoot(root, records) {
  if (Array.isArray(root)) {
    records.push(...root);
  } else if (root && typeof root === "object" && Array.isArray(root.accounts)) {
    records.push(...root.accounts);
  } else {
    records.push(root);
  }
}

/**
 * Parse one Import JSON-compatible text file.  This accepts a single record,
 * an array, {accounts: [...]}, compact JSONL, and pretty-printed adjacent
 * records produced by older Codex exports.
 */
export function parseCodexAccountFile(text) {
  const cleanText = typeof text === "string" ? text.replace(/^\uFEFF/, "").trim() : "";
  if (!cleanText) return { records: [], errors: [{ index: 0, error: "The selected file is empty." }] };

  let roots;
  try {
    roots = [JSON.parse(cleanText)];
  } catch (wholeError) {
    try {
      roots = parseJsonValueStream(cleanText);
    } catch {
      return { records: [], errors: [{ index: 0, error: `Invalid JSON: ${wholeError.message}` }] };
    }
  }

  const rawRecords = [];
  roots.forEach((root) => appendRoot(root, rawRecords));
  const records = [];
  const errors = [];
  rawRecords.forEach((value, index) => {
    const normalized = normalizeCodexAccountRecord(value);
    if (normalized.error) {
      errors.push({ index, error: normalized.error });
    } else {
      records.push(normalized.account);
    }
  });
  return { records, errors };
}

/**
 * Normalize the Import JSON sample and legacy credential/token aliases into
 * the shape consumed by the Auto Login UI.
 */
export function normalizeCodexAccountRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Each account must be a JSON object." };
  }

  const nestedCredentials = value.credentials && typeof value.credentials === "object" && !Array.isArray(value.credentials)
    ? value.credentials
    : null;
  const tokenObject = value.tokens && typeof value.tokens === "object" && !Array.isArray(value.tokens)
    ? value.tokens
    : null;
  const sources = [value, nestedCredentials, tokenObject];

  const email = firstValue(sources, ["email", "username", "login"]);
  const password = firstValue([nestedCredentials, value], ["password", "codexPassword"]);
  const totpSecret = firstValue(
    [nestedCredentials, value],
    ["totpSecret", "totp", "twoFactorSecret", "two_factor", "two_factor_secret", "otp", "totp_secret", "2fa", "2fa_secret"]
  );
  const accessToken = firstValue([tokenObject, value], ["access_token", "accessToken"]);
  const refreshToken = firstValue([tokenObject, value], ["refresh_token", "refreshToken"]);
  const idToken = firstValue([tokenObject, value], ["id_token", "idToken"]);
  const accountId = firstValue(
    [tokenObject, value, nestedCredentials],
    ["account_id", "accountId", "chatgpt_account_id", "chatgptAccountId"]
  );
  const hasTokens = Boolean(accessToken && refreshToken);

  if (!email && !hasTokens) return { error: "Each account must include email." };
  if (!password && !hasTokens) {
    return { error: "Each account must include password or tokens.access_token + tokens.refresh_token." };
  }

  const raw = {
    ...value,
    email,
    password: password || null,
    "2fa": totpSecret || null,
    tokens: {
      access_token: accessToken || "",
      account_id: accountId || "",
      id_token: idToken || "",
      refresh_token: refreshToken || "",
    },
  };

  return {
    account: {
      email: email || accountId || "Unknown account",
      password,
      totpSecret,
      tokens: {
        access_token: accessToken,
        account_id: accountId,
        id_token: idToken,
        refresh_token: refreshToken,
      },
      raw,
    },
  };
}

export function hasCodexTokenPair(account) {
  return Boolean(account?.tokens?.access_token && account?.tokens?.refresh_token);
}
