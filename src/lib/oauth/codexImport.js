/**
 * Codex/ChatGPT token file parser — ported from tools/import-codex
 * (importer-core.js + zip-reader.js) so the dashboard UI can ingest the same
 * file formats the standalone importer handles:
 *   - flat creds object (access_token / accessToken, snake or camel)
 *   - { tokens: {...} } wrapper
 *   - { accounts: [...] } multi-account export
 *   - JSON Lines (one OAuth object per line)
 *   - .zip bundles containing any of the above (*.json entries)
 *
 * Output items match the shape consumed by /api/oauth/codex/bulk-import.
 */
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";

// ─── Minimal ZIP reader (no deps; STORE + DEFLATE, no ZIP64/encrypted) ──────

const SIG_LFH = 0x04034b50;
const SIG_CFH = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD_LOC = 0x07064b50;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

function findEOCD(buf) {
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

function looksLikeZip64(buf, eocdOff) {
  if (eocdOff < 20) return false;
  return buf.readUInt32LE(eocdOff - 20) === SIG_ZIP64_EOCD_LOC;
}

export function readZipEntries(buf, opts = {}) {
  const filter = opts.filter || /\.json$/i;
  const matches = typeof filter === "function" ? filter : (name) => filter.test(name);

  if (!Buffer.isBuffer(buf)) throw new Error("readZipEntries: expected Buffer");
  if (buf.length < 22) throw new Error("ZIP file too small");

  const eocdOff = findEOCD(buf);
  if (eocdOff < 0) throw new Error("EOCD not found — not a valid ZIP file");

  const totalEntries = buf.readUInt16LE(eocdOff + 10);
  const cdSize = buf.readUInt32LE(eocdOff + 12);
  const cdOffset = buf.readUInt32LE(eocdOff + 16);

  if (
    totalEntries === U16_MAX ||
    cdSize === U32_MAX ||
    cdOffset === U32_MAX ||
    looksLikeZip64(buf, eocdOff)
  ) {
    throw new Error(
      "ZIP64 not supported (>4GB or >65535 entries). Extract the archive and import the JSON files directly."
    );
  }
  if (cdOffset + cdSize > buf.length) throw new Error("Central directory out of range");

  const out = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > buf.length) throw new Error("Central directory truncated");
    if (buf.readUInt32LE(p) !== SIG_CFH) throw new Error("Bad central file header signature");
    const compressionMethod = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const fileNameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lhOffset = buf.readUInt32LE(p + 42);
    // Compress-Archive on Windows occasionally emits backslashes in entry names.
    const name = buf.slice(p + 46, p + 46 + fileNameLen).toString("utf8").replace(/\\/g, "/");
    p += 46 + fileNameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // directory entry
    if (compressedSize === U32_MAX || uncompressedSize === U32_MAX || lhOffset === U32_MAX) {
      throw new Error(`ZIP64 not supported (entry "${name}" exceeds 4GB)`);
    }
    if (!matches(name)) continue;

    if (lhOffset + 30 > buf.length) throw new Error("Local header out of range");
    if (buf.readUInt32LE(lhOffset) !== SIG_LFH) throw new Error(`Bad local header for "${name}"`);
    if (buf.readUInt16LE(lhOffset + 6) & 0x0001) {
      throw new Error(`Entry "${name}" is encrypted — not supported`);
    }
    const lhFileNameLen = buf.readUInt16LE(lhOffset + 26);
    const lhExtraLen = buf.readUInt16LE(lhOffset + 28);
    const dataStart = lhOffset + 30 + lhFileNameLen + lhExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) throw new Error(`Entry data for "${name}" truncated`);
    const compressed = buf.slice(dataStart, dataEnd);

    let raw;
    if (compressionMethod === 0) raw = compressed;
    else if (compressionMethod === 8) raw = zlib.inflateRawSync(compressed);
    else throw new Error(`Entry "${name}" uses unsupported compression method ${compressionMethod}`);

    out.push({ name, text: raw.toString("utf8"), sizeUncompressed: raw.length });
  }
  return out;
}

// ─── JWT claims decode (no signature verification — claims only) ────────────

function base64UrlDecode(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  let str = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = str.length % 4;
  if (pad === 2) str += "==";
  else if (pad === 3) str += "=";
  else if (pad !== 0) return null;
  try {
    return Buffer.from(str, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function decodeJwtPayload(jwt) {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  const decoded = base64UrlDecode(parts[1]);
  if (!decoded) return null;
  try {
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

// ─── Shape detection + parsing (ported from importer-core.js) ───────────────

// Copy-pasted tokens often carry BOM/CRLF junk; strip before treating as JWT.
function stripBom(s) {
  if (typeof s !== "string" || s.length === 0) return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
function cleanToken(t) {
  if (typeof t !== "string") return t;
  return stripBom(t).trim();
}

function flattenCodexShape(data) {
  if (Array.isArray(data)) {
    if (data.length === 0) return { error: "Empty array" };
    const first = data.find((x) => x && typeof x === "object");
    if (!first) return { error: "Array has no valid object" };
    return flattenCodexShape(first);
  }
  if (data.accounts && Array.isArray(data.accounts)) {
    const acc = data.accounts.find(
      (a) =>
        a &&
        typeof a === "object" &&
        (a.platform === "openai" ||
          a.platform === "codex" ||
          a.type === "codex" ||
          (a.credentials && (a.credentials.access_token || a.credentials.accessToken)))
    );
    if (!acc) return { error: 'No openai/codex account found in "accounts[]"' };
    return {
      flat: {
        ...(acc.credentials || {}),
        ...(acc.extra || {}),
        email:
          (acc.extra && acc.extra.email) ||
          acc.name ||
          (acc.credentials && acc.credentials.email),
        account_id:
          (acc.credentials && acc.credentials.chatgpt_account_id) ||
          (acc.credentials && acc.credentials.account_id),
      },
    };
  }
  if (data.tokens && typeof data.tokens === "object" && !Array.isArray(data.tokens)) {
    return {
      flat: {
        ...data.tokens,
        email: data.tokens.email || data.email,
        last_refresh: data.last_refresh || data.tokens.last_refresh,
      },
    };
  }
  return { flat: data };
}

// A file may hold one object, an array, an accounts[] wrapper, or JSON Lines.
// Return every account instead of silently taking only the first item.
export function parseCodexDocuments(jsonText) {
  const cleanText = stripBom(typeof jsonText === "string" ? jsonText : "").trim();
  if (!cleanText) return [{ error: "Empty JSON file" }];

  let root;
  try {
    root = JSON.parse(cleanText);
  } catch (wholeError) {
    const lines = cleanText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return [{ error: `Invalid JSON: ${wholeError.message}` }];
    const values = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        values.push(JSON.parse(lines[i]));
      } catch (lineError) {
        return [{ error: `JSONL line ${i + 1} invalid: ${lineError.message}` }];
      }
    }
    root = values;
  }

  let documents;
  if (Array.isArray(root)) documents = root;
  else if (root && Array.isArray(root.accounts)) documents = root.accounts.map((a) => ({ accounts: [a] }));
  else documents = [root];

  if (documents.length === 0) return [{ error: "No accounts in file" }];
  return documents.map((doc) => parseCodexObject(doc));
}

function parseCodexObject(data) {
  if (!data || typeof data !== "object") return { error: "Account must be a JSON object" };

  const flat = flattenCodexShape(data);
  if (flat.error) return { error: flat.error };
  data = flat.flat;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Account must be a JSON object after flattening" };
  }

  const accessToken = cleanToken(data.access_token || data.accessToken);
  const refreshToken = cleanToken(data.refresh_token || data.refreshToken);
  if (typeof accessToken !== "string" || !accessToken) return { error: "Missing access_token" };
  if (typeof refreshToken !== "string" || !refreshToken) return { error: "Missing refresh_token" };

  const idToken = cleanToken(data.id_token || data.idToken);
  const idTokenClaims = decodeJwtPayload(idToken) || {};
  const accessClaims = decodeJwtPayload(accessToken) || {};

  const profile =
    idTokenClaims["https://api.openai.com/profile"] ||
    accessClaims["https://api.openai.com/profile"] ||
    {};
  const auth =
    idTokenClaims["https://api.openai.com/auth"] ||
    accessClaims["https://api.openai.com/auth"] ||
    {};

  const email =
    (typeof profile.email === "string" && profile.email.trim()) ||
    (typeof data.email === "string" && data.email.trim()) ||
    null;

  const chatgptAccountId =
    (typeof auth.chatgpt_account_id === "string" && auth.chatgpt_account_id) ||
    (typeof data.chatgpt_account_id === "string" && data.chatgpt_account_id) ||
    (typeof data.account_id === "string" && data.account_id) ||
    null;

  const chatgptPlanType =
    (typeof auth.chatgpt_plan_type === "string" && auth.chatgpt_plan_type) || "free";

  // expiresAt: accept ISO strings and Unix epochs (s or ms); fall back to
  // last_refresh + 10d, then now + 10d.
  let expiresAt = null;
  const epochToIso = (n) => {
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms).toISOString();
  };
  const expiredField = data.expired || data.expires_at || data.expiresAt;
  if (typeof expiredField === "string" && expiredField) {
    const t = Date.parse(expiredField);
    if (!Number.isNaN(t)) expiresAt = new Date(t).toISOString();
  } else if (typeof expiredField === "number") {
    expiresAt = epochToIso(expiredField);
  }
  if (!expiresAt && typeof data.expires_in === "number" && data.expires_in > 0) {
    expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  }
  if (!expiresAt && typeof data.last_refresh === "string") {
    const t = Date.parse(data.last_refresh);
    if (!Number.isNaN(t)) expiresAt = new Date(t + 10 * 24 * 3600 * 1000).toISOString();
  }
  if (!expiresAt) expiresAt = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();

  const name = email
    ? email
    : chatgptAccountId
    ? `Codex ${chatgptAccountId.slice(0, 8)}`
    : `Codex ${randomUUID().slice(0, 8)}`;

  return {
    account: {
      name,
      email: email || undefined,
      accessToken,
      refreshToken,
      ...(idToken ? { idToken } : {}),
      expiresAt,
      providerSpecificData: {
        chatgptAccountId: chatgptAccountId || "",
        chatgptPlanType: chatgptPlanType || "free",
        authMethod: "imported",
        provider: "Imported",
      },
    },
    // Safe-to-display summary — never includes tokens.
    source: {
      email,
      chatgptAccountId,
      chatgptPlanType,
      expiresAt,
      refreshTail: refreshToken.slice(-8),
    },
  };
}

/**
 * Parse uploaded files into importable accounts.
 * @param {Array<{name:string, text?:string, zip?:string}>} files
 *   `text` = raw JSON content; `zip` = base64-encoded ZIP archive.
 * @returns {{ accounts: Array, preview: Array, errors: Array<{name:string,error:string}> }}
 */
export function parseCodexUploads(files) {
  const accounts = [];
  const preview = [];
  const errors = [];

  for (const f of files || []) {
    const name = String(f?.name || "unnamed");
    let docs = [];
    try {
      if (typeof f.zip === "string" && f.zip) {
        const buf = Buffer.from(f.zip, "base64");
        docs = readZipEntries(buf).flatMap((e) =>
          parseCodexDocuments(e.text).map((d) => ({ ...d, _from: `${name}!${e.name}` }))
        );
      } else if (typeof f.text === "string") {
        docs = parseCodexDocuments(f.text).map((d) => ({ ...d, _from: name }));
      } else {
        errors.push({ name, error: "Missing file content (text or zip expected)" });
        continue;
      }
    } catch (err) {
      errors.push({ name, error: err.message || "Failed to read file" });
      continue;
    }

    for (const d of docs) {
      const label = d._from || name;
      if (d.error) {
        errors.push({ name: label, error: d.error });
      } else {
        accounts.push(d.account);
        preview.push({ name: label, ...d.source });
      }
    }
  }

  return { accounts, preview, errors };
}
