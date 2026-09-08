import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { generateAuthData, exchangeTokens } from "@/lib/oauth/providers";
import { createProviderConnection } from "@/models";
import { generateTotp } from "./totp.js";

const JOBS = Symbol.for("9router.codexAutoLogin.jobs");
const DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback";
const MAX_ACCOUNTS = 100;
const MAX_CONCURRENCY = 4;
const ACCOUNT_TIMEOUT_MS = 120_000;
const globalState = globalThis;
if (!globalState[JOBS]) globalState[JOBS] = new Map();

const selectors = {
  email: [
    'input[name="email"]',
    'input[type="email"]',
    'input[name="username"]',
    'input[id*="email" i]',
    'input[placeholder*="email" i]',
    'input[autocomplete="username"]',
  ],
  password: [
    'input[name="password"]',
    'input[type="password"]',
    'input[id*="password" i]',
    'input[autocomplete="current-password"]',
    'input[placeholder*="password" i]',
  ],
  otp: [
    'input[name="code"]',
    'input[inputmode="numeric"]',
    'input[autocomplete="one-time-code"]',
    'input[id*="code" i]',
    'input[placeholder*="verification" i]',
    'input[aria-label*="code" i]',
  ],
};

function jobs() {
  return globalState[JOBS];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publicError(error) {
  const message = String(error?.message || error || "Authentication failed").toLowerCase();
  if (message.includes("timeout")) return "timeout";
  if (message.includes("totp") || message.includes("2fa") || message.includes("verification code")) return "invalid_totp";
  if (message.includes("token exchange")) return "token_exchange_failed";
  if (message.includes("cancel")) return "cancelled";
  if (message.includes("browser") || message.includes("playwright") || message.includes("executable")) return "browser_unavailable";
  return "authentication_failed";
}

function findBrowserExecutable() {
  const configured = process.env.CODEX_AUTO_LOGIN_BROWSER_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (configured && fs.existsSync(configured)) return configured;
  const candidates = process.platform === "win32"
    ? [
        path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Chromium", "Application", "chrome.exe"),
      ]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/snap/bin/chromium",
        ];
  const existing = candidates.find((path) => fs.existsSync(path));
  if (existing) return existing;
  const commands = process.platform === "win32"
    ? ["chrome.exe", "chromium.exe"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const command of commands) {
    try {
      const result = process.platform === "win32"
        ? execFileSync("where.exe", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/)[0].trim()
        : execFileSync("sh", ["-lc", `command -v ${command}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (result) return result;
    } catch {
      // Continue through the known executable candidates.
    }
  }
  return undefined;
}

async function loadChromium() {
  let playwright;
  try {
    playwright = await import("playwright-core");
  } catch {
    throw new Error("Playwright Core is not installed");
  }
  const chromium = playwright.chromium || playwright.default?.chromium;
  if (!chromium) throw new Error("Playwright Chromium is unavailable");
  return chromium;
}

async function firstVisible(page, candidates, timeoutMs, action) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of candidates) {
      try {
        const locator = page.locator(selector).first();
        if (await locator.isVisible()) {
          if (action) await action(locator);
          return locator;
        }
      } catch {
        // The identity provider replaces forms during navigation.
      }
    }
    await sleep(150);
  }
  return null;
}

async function clickContinue(page, timeoutMs = 2_000) {
  return firstVisible(page, [
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'button:has-text("Authorize")',
    'button:has-text("Allow")',
    'button:has-text("Accept")',
    'button:has-text("Verify")',
    'button:has-text("Submit")',
  ], timeoutMs, (locator) => locator.click()).then(Boolean);
}

async function waitForNavigationSettled(page, ms) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: ms });
  } catch {
    // A callback route is fulfilled locally and can end the navigation early.
  }
  await sleep(Math.min(ms, 800));
}

async function runBrowserAttempt(account, job) {
  const chromium = await loadChromium();
  const executablePath = findBrowserExecutable();
  const launchOptions = {
    headless: !job.headed,
    args: ["--disable-dev-shm-usage"],
  }; // headed mode is useful for CAPTCHA/manual intervention.
  // Chromium refuses to start as root on Linux unless sandboxing is disabled.
  // Keep the safer default for normal users and only opt out in root containers.
  if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0) {
    launchOptions.args.push("--no-sandbox", "--disable-setuid-sandbox");
  }
  if (executablePath) launchOptions.executablePath = executablePath;
  const browser = await chromium.launch(launchOptions);
  job.activeBrowsers.add(browser);

  let context;
  let callbackResolve;
  let callbackReject;
  const callbackPromise = new Promise((resolve, reject) => {
    callbackResolve = resolve;
    callbackReject = reject;
  });
  // Cleanup can happen before the callback waiter is consumed.
  callbackPromise.catch(() => {});
  const callbackTimeout = setTimeout(() => callbackReject(new Error("OAuth callback timeout")), ACCOUNT_TIMEOUT_MS);

  try {
    context = await browser.newContext();
    const page = await context.newPage();
    const authData = await generateAuthData("codex", DEFAULT_REDIRECT_URI);
    const { state, codeVerifier, authUrl } = authData;
    let callbackSeen = false;

    await context.route("http://localhost:1455/auth/callback**", async (route) => {
      const callbackUrl = new URL(route.request().url());
      const callbackState = callbackUrl.searchParams.get("state");
      if (callbackState !== state) {
        await route.fulfill({ status: 400, body: "Invalid OAuth state" });
        return;
      }
      callbackSeen = true;
      const code = callbackUrl.searchParams.get("code");
      const error = callbackUrl.searchParams.get("error");
      const errorDescription = callbackUrl.searchParams.get("error_description");
      callbackResolve({ code, error: errorDescription || error, state: callbackState });
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<html><body><h2>Authentication complete</h2><p>You can close this tab.</p></body></html>",
      });
    });

    const navigation = page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((error) => {
      if (!callbackSeen) throw error;
    });
    await firstVisible(page, selectors.email, 12_000, (locator) => locator.fill(account.email));
    const emailInput = await firstVisible(page, selectors.email, 1_000);
    if (!emailInput && !callbackSeen) throw new Error("Email form not found");
    if (emailInput) await clickContinue(page);

    const passwordInput = await firstVisible(page, selectors.password, 12_000, (locator) => locator.fill(account.password));
    if (!passwordInput && !callbackSeen) throw new Error("Password form not found");
    if (passwordInput) {
      await clickContinue(page);
      await waitForNavigationSettled(page, 1_500);
    }

    if (account.totpSecret && !callbackSeen) {
      const otpInput = await firstVisible(page, selectors.otp, 10_000);
      if (otpInput) {
        let code;
        try {
          code = generateTotp(account.totpSecret);
        } catch {
          throw new Error("Invalid TOTP secret");
        }
        await otpInput.fill(code);
        await clickContinue(page, 3_000);
        await waitForNavigationSettled(page, 2_000);
      }
    }

    for (let consentAttempt = 0; consentAttempt < 3 && !callbackSeen; consentAttempt += 1) {
      await clickContinue(page, 1_500);
      await sleep(300);
      if (consentAttempt < 2 && !callbackSeen) {
        const body = await page.locator("body").innerText().catch(() => "");
        if (/invalid_state|session ended/i.test(`${page.url()} ${body}`)) {
          throw new Error("OAuth session ended");
        }
      }
    }

    await navigation;
    const callback = await callbackPromise;
    if (callback.error) throw new Error(`OAuth error: ${callback.error}`);
    if (!callback.code || callback.state !== state) throw new Error("Invalid OAuth callback");

    const tokenData = await exchangeTokens("codex", callback.code, DEFAULT_REDIRECT_URI, codeVerifier, state);
    const connection = await createProviderConnection({
      provider: "codex",
      authType: "oauth",
      ...tokenData,
      email: tokenData.email || account.email,
      expiresAt: tokenData.expiresIn ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString() : null,
      testStatus: "active",
    });
    return { id: connection.id, email: connection.email || tokenData.email || account.email };
  } finally {
    clearTimeout(callbackTimeout);
    callbackReject(new Error("Browser closed"));
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
    job.activeBrowsers.delete(browser);
  }
}

async function processAccount(job, account) {
  const record = job.accounts.find((item) => item.id === account.id);
  if (!record) return;
  record.status = "running";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (job.cancelRequested) break;
    record.attempts = attempt;
    try {
      const result = await runBrowserAttempt(account, job);
      record.status = "success";
      record.connectionId = result.id;
      record.email = result.email || record.email;
      delete record.error;
      job.succeeded += 1;
      return;
    } catch (error) {
      record.error = publicError(error);
      if (attempt < 3 && !job.cancelRequested) await sleep(500 * attempt);
    }
  }
  record.status = job.cancelRequested ? "cancelled" : "failed";
  if (record.status === "failed") job.failed += 1;
}

async function runJob(job) {
  let cursor = 0;
  const worker = async () => {
    while (!job.cancelRequested) {
      const index = cursor++;
      const account = job.credentials[index];
      if (!account) return;
      await processAccount(job, account);
      // Drop secrets as soon as an account reaches a terminal state.
      job.credentials[index] = null;
    }
  };
  await Promise.all(Array.from({ length: job.concurrency }, worker));
  job.status = job.cancelRequested ? "stopped" : "completed";
  job.finishedAt = new Date().toISOString();
  job.credentials = [];
}

function publicJob(job) {
  const results = job.accounts.map(({ id, email, status, attempts, connectionId, error }) => ({
    id, email, status, attempts, ...(connectionId ? { connectionId } : {}), ...(error ? { error } : {}),
  }));
  const done = job.accounts.filter((account) => ["success", "failed", "cancelled"].includes(account.status)).length;
  const running = ["queued", "running", "stopping"].includes(job.status);
  return {
    id: job.id,
    jobId: job.id,
    status: job.status,
    running,
    completed: job.status === "completed",
    stopped: job.status === "stopped",
    headed: job.headed,
    concurrency: job.concurrency,
    workersRequested: job.concurrency,
    workersRunning: job.activeBrowsers.size,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || null,
    total: job.accounts.length,
    done,
    succeeded: job.succeeded,
    failed: job.failed,
    cancelled: job.accounts.filter((account) => account.status === "cancelled").length,
    results,
    accounts: results,
    activeAccounts: job.accounts.filter((account) => account.status === "running").map((account) => account.email),
    currentEmail: job.accounts.find((account) => account.status === "running")?.email || null,
    completedAt: job.finishedAt || null,
  };
}

function parseAccount(value, index) {
  if (typeof value === "string") {
    const parts = value.trim().split("|");
    if (parts.length < 2 || !parts[0].trim() || !parts[1].trim()) return null;
    return { id: `account-${index + 1}`, email: parts[0].trim(), password: parts[1].trim(), totpSecret: parts[2]?.trim() || "" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = value.credentials && typeof value.credentials === "object" && !Array.isArray(value.credentials)
    ? value.credentials
    : null;
  const sources = [value, nested];
  const firstNonEmpty = (keys) => {
    for (const source of sources) {
      if (!source) continue;
      for (const key of keys) {
        const candidate = source[key];
        if (candidate !== undefined && candidate !== null && String(candidate).trim()) {
          return String(candidate);
        }
      }
    }
    return "";
  };
  const email = firstNonEmpty(["email", "username"]).trim();
  const password = firstNonEmpty(["password"]);
  if (!email || !password) return null;
  const totpSecret = firstNonEmpty([
    "totpSecret",
    "totp",
    "twoFactorSecret",
    "two_factor",
    "two_factor_secret",
    "otp",
    "totp_secret",
    "2fa",
    "2fa_secret",
  ]).trim();
  return { id: `account-${index + 1}`, email, password, totpSecret };
}

export function parseAccounts(input) {
  const values = typeof input === "string"
    ? input.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
    : Array.isArray(input) ? input : [];
  if (!values.length || values.length > MAX_ACCOUNTS) throw new Error(`Provide between 1 and ${MAX_ACCOUNTS} accounts`);
  const accounts = values.map(parseAccount).filter(Boolean);
  if (accounts.length !== values.length) throw new Error("Each account must include email and password");
  return accounts;
}

export function createAutoLoginJob({ accounts, headed = false, concurrency = 2 }) {
  const job = {
    id: cryptoRandomId(),
    status: "queued",
    headed: Boolean(headed),
    concurrency: Math.max(1, Math.min(MAX_CONCURRENCY, Number(concurrency) || 2)),
    createdAt: new Date().toISOString(),
    finishedAt: null,
    accounts: accounts.map(({ id, email }) => ({ id, email, status: "queued", attempts: 0 })),
    credentials: accounts,
    succeeded: 0,
    failed: 0,
    cancelRequested: false,
    activeBrowsers: new Set(),
  };
  jobs().set(job.id, job);
  job.status = "running";
  runJob(job).catch(() => {
    job.status = job.cancelRequested ? "stopped" : "failed";
    job.finishedAt = new Date().toISOString();
    job.credentials = [];
  });
  return publicJob(job);
}

function cryptoRandomId() {
  return `codex-auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getAutoLoginJob(id) {
  const job = jobs().get(id);
  return job ? publicJob(job) : null;
}

export async function stopAutoLoginJob(id) {
  const job = jobs().get(id);
  if (!job) return null;
  job.cancelRequested = true;
  for (const browser of job.activeBrowsers) await browser.close().catch(() => {});
  if (job.status === "queued" || job.status === "running") job.status = "stopping";
  return publicJob(job);
}

export { MAX_ACCOUNTS, MAX_CONCURRENCY };
