import crypto from "crypto";

function decodeBase32(value) {
  const normalized = value.replace(/=+$/g, "").toUpperCase();
  if (!/^[A-Z2-7]+$/.test(normalized)) {
    throw new Error("Invalid TOTP secret");
  }

  let bits = "";
  for (const character of normalized) {
    bits += ("00000" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(character).toString(2)).slice(-5);
  }

  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

export function parseTotpSecret(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  if (!raw.toLowerCase().startsWith("otpauth://")) {
    return { secret: raw.replace(/[\s=-]/g, "").toUpperCase(), algorithm: "sha1", digits: 6, period: 30 };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid TOTP URI");
  }
  if (parsed.protocol !== "otpauth:" || parsed.hostname.toLowerCase() !== "totp") {
    throw new Error("Only TOTP secrets are supported");
  }

  const secret = parsed.searchParams.get("secret")?.replace(/[\s=-]/g, "").toUpperCase();
  if (!secret) throw new Error("TOTP URI has no secret");
  const algorithm = (parsed.searchParams.get("algorithm") || "SHA1").toLowerCase();
  const digits = Number(parsed.searchParams.get("digits") || 6);
  const period = Number(parsed.searchParams.get("period") || 30);
  if (!Number.isInteger(digits) || ![6, 8].includes(digits) || !Number.isInteger(period) || period <= 0) {
    throw new Error("Invalid TOTP parameters");
  }
  return { secret, algorithm, digits, period };
}

export function generateTotp(input, now = Date.now()) {
  const config = parseTotpSecret(input);
  if (!config) return "";
  const key = decodeBase32(config.secret);
  const counter = Math.floor(now / 1000 / config.period);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(config.algorithm, key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** config.digits)).padStart(config.digits, "0");
}
