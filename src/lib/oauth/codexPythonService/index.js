import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const SERVICE_STATE = Symbol.for("9router.codexPythonService.state");
const DEFAULT_SERVICE_URL = "http://127.0.0.1:9876";
const HEALTH_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 200;

const globalState = globalThis;
if (!globalState[SERVICE_STATE]) {
  globalState[SERVICE_STATE] = {
    process: null,
    owned: false,
    startPromise: null,
    activeJob: null,
    cleanupInstalled: false,
  };
}

function state() {
  return globalState[SERVICE_STATE];
}

function serviceUrl() {
  return (process.env.CODEX_PYTHON_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class PythonServiceError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = "PythonServiceError";
    this.statusCode = statusCode;
  }
}

function pythonScriptPath() {
  const configured = process.env.CODEX_PYTHON_SERVER_PATH;
  const candidates = [
    configured,
    path.resolve(process.cwd(), "python/codex-auto-login/server.py"),
    path.resolve(process.cwd(), "../python/codex-auto-login/server.py"),
    path.resolve(process.cwd(), "../oAuth-9router/server.py"),
    path.resolve(process.cwd(), "oAuth-9router/server.py"),
    path.join(os.homedir(), "oAuth-9router", "server.py"),
    process.platform === "win32" ? null : "/home/linh/oAuth-9router/server.py",
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new PythonServiceError(
      `Python auto-login backend not found. Set CODEX_PYTHON_SERVER_PATH to server.py.`,
      503
    );
  }
  return path.resolve(found);
}

function pythonCommands(script) {
  const configured = process.env.CODEX_PYTHON_EXECUTABLE || process.env.PYTHON_EXECUTABLE;
  if (configured) return [{ command: configured, args: [] }];
  const sidecarRoot = script ? path.dirname(script) : null;
  const roots = [
    sidecarRoot,
    sidecarRoot ? path.resolve(sidecarRoot, "..", "..") : null,
    pythonRuntimeDir(),
    process.cwd(),
    path.join(os.homedir(), "oAuth-9router"),
  ].filter(Boolean);
  const venvCandidates = [];
  const seen = new Set();
  for (const root of roots) {
    const executable = process.platform === "win32"
      ? path.join(root, ".venv", "Scripts", "python.exe")
      : path.join(root, ".venv", "bin", "python");
    if (!seen.has(executable) && fs.existsSync(executable)) {
      seen.add(executable);
      venvCandidates.push({ command: executable, args: [] });
    }
  }
  if (process.platform === "win32") {
    return [
      ...venvCandidates,
      { command: "py", args: ["-3"] },
      { command: "python", args: [] },
      { command: "python3", args: [] },
    ];
  }
  return [
    ...venvCandidates,
    { command: "python3", args: [] },
    { command: "python", args: [] },
  ];
}

function pythonRuntimeDir() {
  return process.env.CODEX_PYTHON_RUNTIME_DIR
    || path.join(os.homedir(), ".9router", "runtime", "codex-auto-login");
}

function pythonExecutablePath(runtimeDir) {
  return process.platform === "win32"
    ? path.join(runtimeDir, ".venv", "Scripts", "python.exe")
    : path.join(runtimeDir, ".venv", "bin", "python");
}

function runPythonCommand(command, args, timeout = 30_000) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "unknown error").trim();
    throw new PythonServiceError(`Python bootstrap failed: ${detail}`, 503);
  }
  return result;
}

function pythonModulesReady(candidate) {
  try {
    runPythonCommand(candidate.command, [...candidate.args, "-c", "import pyotp, playwright.sync_api"], 15_000);
    return true;
  } catch {
    return false;
  }
}

function playwrightBrowserReady(candidate) {
  try {
    runPythonCommand(candidate.command, [...candidate.args, "-c", [
      "import os",
      "from playwright.sync_api import sync_playwright",
      "with sync_playwright() as p:",
      "    raise SystemExit(0 if os.path.exists(p.chromium.executable_path) else 1)",
    ].join("\n")], 20_000);
    return true;
  } catch {
    return false;
  }
}

function requirementsPath(script) {
  const candidates = [
    path.join(path.dirname(script), "requirements.txt"),
    path.resolve(process.cwd(), "python", "codex-auto-login", "requirements.txt"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new PythonServiceError("Python sidecar requirements.txt was not found.", 503);
  return found;
}

function bootstrapPythonRuntime(script) {
  const configured = process.env.CODEX_PYTHON_EXECUTABLE || process.env.PYTHON_EXECUTABLE;
  const explicit = configured ? { command: configured, args: [] } : null;
  const candidates = explicit ? [explicit] : pythonCommands(script);
  const autoInstall = process.env.CODEX_PYTHON_AUTO_INSTALL !== "false";
  const skipBrowser = process.env.CODEX_PYTHON_SKIP_BROWSER_INSTALL === "true";
  const runtimePython = { command: pythonExecutablePath(pythonRuntimeDir()), args: [] };
  if (!explicit && fs.existsSync(runtimePython.command) && !pythonModulesReady(runtimePython)) {
    if (!autoInstall) {
      throw new PythonServiceError("Python sidecar dependencies are missing from the runtime venv.", 503);
    }
    runPythonCommand(runtimePython.command, ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirementsPath(script)], 300_000);
  }
  const existing = candidates.find((candidate) => pythonModulesReady(candidate));
  if (existing) {
    if (!skipBrowser && !playwrightBrowserReady(existing)) {
      if (!autoInstall) {
        throw new PythonServiceError("Playwright Chromium is missing. Run `python -m playwright install chromium`.", 503);
      }
      runPythonCommand(existing.command, [...existing.args, "-m", "playwright", "install", "chromium"], 300_000);
    }
    return existing;
  }
  if (!autoInstall) {
    throw new PythonServiceError(
      "Python dependencies are missing. Set CODEX_PYTHON_AUTO_INSTALL=true or install python/codex-auto-login/requirements.txt.",
      503
    );
  }
  const base = (explicit ? [explicit] : pythonCommands(script)).find((candidate) => {
    try {
      runPythonCommand(candidate.command, [...candidate.args, "--version"], 15_000);
      return true;
    } catch {
      return false;
    }
  });
  if (!base) throw new PythonServiceError("No usable Python interpreter found. Set CODEX_PYTHON_EXECUTABLE.", 503);

  const runtimeDir = pythonRuntimeDir();
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (!fs.existsSync(runtimePython.command)) {
    runPythonCommand(base.command, [...base.args, "-m", "venv", path.join(runtimeDir, ".venv")], 120_000);
  }
  runPythonCommand(runtimePython.command, ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirementsPath(script)], 300_000);
  if (!skipBrowser) {
    runPythonCommand(runtimePython.command, ["-m", "playwright", "install", "chromium"], 300_000);
  }
  return runtimePython;
}

async function fetchJson(endpoint, options = {}, timeoutMs = HEALTH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${serviceUrl()}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: { Accept: "application/json", ...(options.headers || {}) },
      cache: "no-store",
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { error: text || `Python service returned HTTP ${response.status}` };
    }
    if (!response.ok) {
      throw new PythonServiceError(payload.error || `Python service returned HTTP ${response.status}`, response.status);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function isHealthy() {
  try {
    const payload = await fetchJson("/api/health");
    return payload?.ok === true;
  } catch {
    return false;
  }
}

function watchProcess(child) {
  child.once("exit", () => {
    const current = state();
    if (current.activeJob && current.owned && current.activeJob.finishedAt === null) {
      current.activeJob.backendError = "Python auto-login backend exited unexpectedly";
    }
    if (current.process === child) {
      current.process = null;
      current.owned = false;
    }
  });
  child.once("error", () => {
    child.spawnError = new Error("Unable to execute Python auto-login backend");
    const current = state();
    if (current.activeJob && current.owned && current.activeJob.finishedAt === null) {
      current.activeJob.backendError = "Unable to execute Python auto-login backend";
    }
    if (current.process === child) {
      current.process = null;
      current.owned = false;
    }
  });
}

async function waitForHealth(child) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isHealthy()) return;
    if (child.spawnError) throw new PythonServiceError(child.spawnError.message, 503);
    if (child.exitCode !== null || child.signalCode) {
      throw new PythonServiceError("Python auto-login backend exited before it became ready", 503);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new PythonServiceError("Timed out waiting for Python auto-login backend", 503);
}

async function startService() {
  if (await isHealthy()) return;
  const script = pythonScriptPath();
  const preferredPython = bootstrapPythonRuntime(script);
  let lastError;
  for (const candidate of [preferredPython]) {
    let child;
    try {
      child = spawn(candidate.command, [...candidate.args, script], {
        cwd: path.dirname(script),
        env: {
          ...process.env,
          CODEX_PYTHON_SIDECAR: "1",
          PYTHONUNBUFFERED: "1",
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          CODEX_PYTHON_RUNTIME_DIR: pythonRuntimeDir(),
        },
        stdio: "ignore",
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      state().process = child;
      state().owned = true;
      watchProcess(child);
      await waitForHealth(child);
      installCleanup();
      return;
    } catch (error) {
      lastError = error;
      if (child && child.exitCode === null) child.kill();
      state().process = null;
      state().owned = false;
      if (error instanceof PythonServiceError && /timed out|exited before/.test(error.message)) break;
    }
  }
  throw lastError || new PythonServiceError("Unable to start Python auto-login backend", 503);
}

function installCleanup() {
  const current = state();
  if (current.cleanupInstalled) return;
  current.cleanupInstalled = true;
  process.once("exit", () => {
    if (!current.owned || !current.process || current.process.exitCode !== null) return;
    if (process.platform !== "win32" && current.process.pid) {
      try {
        process.kill(-current.process.pid, "SIGTERM");
        return;
      } catch {
        // Fall back to terminating the sidecar itself.
      }
    }
    if (process.platform === "win32" && current.process.pid) {
      try {
        spawnSync("taskkill", ["/PID", String(current.process.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        return;
      } catch {
        // Fall back to terminating the sidecar itself.
      }
    }
    current.process.kill();
  });
}

export async function ensurePythonService() {
  const current = state();
  if (await isHealthy()) return;
  if (!current.startPromise) {
    current.startPromise = startService().finally(() => {
      current.startPromise = null;
    });
  }
  await current.startPromise;
}

function mapJobStatus(raw) {
  const current = state();
  const job = current.activeJob;
  if (!job) throw new PythonServiceError("Auto-login job not found", 404);
  const rawResults = Array.isArray(raw?.results) ? raw.results : [];
  const resultByEmail = new Map(rawResults.map((result) => [String(result.email || "").toLowerCase(), result]));
  const backendError = job.backendError || "";
  const running = !backendError && (raw?.running === true || (Date.now() < job.startGraceUntil && rawResults.length === 0));
  const stopped = raw?.stopped === true;
  const terminalWithoutResult = !backendError
    && !stopped
    && raw?.running === false
    && Date.now() >= job.startGraceUntil;
  const results = job.accounts.map((account) => {
    const result = resultByEmail.get(account.email.toLowerCase());
    if (result?.status === "success") {
      return { id: account.id, email: account.email, status: "success", attempts: 1, imported: true };
    }
    if (result?.status === "error") {
      return { id: account.id, email: account.email, status: "failed", attempts: 1, error: result.error || "Authentication failed", imported: false };
    }
    if (result?.status === "stopped") {
      return { id: account.id, email: account.email, status: "cancelled", attempts: 1, error: result.error || "Stopped by user" };
    }
    if (backendError) {
      return { id: account.id, email: account.email, status: "failed", attempts: 0, error: backendError, imported: false };
    }
    if (terminalWithoutResult) {
      return {
        id: account.id,
        email: account.email,
        status: "failed",
        attempts: 0,
        error: "Python auto-login finished without a result",
        imported: false,
      };
    }
    const active = Array.isArray(raw?.activeAccounts) && raw.activeAccounts.includes(account.email);
    return { id: account.id, email: account.email, status: active ? "running" : (running ? "queued" : "cancelled"), attempts: 0 };
  });
  const succeeded = results.filter((result) => result.status === "success").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const cancelled = results.filter((result) => result.status === "cancelled").length;
  const complete = !running && (Boolean(backendError) || stopped || succeeded + failed + cancelled >= job.accounts.length);
  if (complete && !job.finishedAt) job.finishedAt = new Date().toISOString();
  const status = stopped ? "stopped" : backendError ? "failed" : complete ? "completed" : "running";
  return {
    id: job.id,
    jobId: job.id,
    status,
    running: status === "running",
    completed: status === "completed",
    stopped: status === "stopped",
    headed: job.headed,
    concurrency: job.workers,
    workersRequested: job.workers,
    workersRunning: Number(raw?.workersRunning) || 0,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || null,
    completedAt: job.finishedAt || null,
    total: job.accounts.length,
    done: succeeded + failed + cancelled,
    succeeded,
    failed,
    cancelled,
    results,
    accounts: results,
    activeAccounts: Array.isArray(raw?.activeAccounts) ? raw.activeAccounts : [],
    currentEmail: raw?.currentEmail || null,
  };
}

export async function startPythonAutoLogin({ accounts, workers = 3, headed = false }) {
  await ensurePythonService();
  const current = state();
  const backendStatus = await fetchJson("/api/oauth/auto-status");
  if (backendStatus?.running === true) {
    throw new PythonServiceError("Another auto-login job is already running", 409);
  }
  if (current.activeJob) {
    const existing = mapJobStatus(backendStatus);
    if (existing.running) throw new PythonServiceError("Another auto-login job is already running", 409);
  }
  const workerCount = Math.max(1, Math.min(32, Number(workers) || 3));
  const job = {
    id: `codex-python-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    workers: workerCount,
    headed: Boolean(headed),
    startGraceUntil: Date.now() + 5_000,
    backendError: "",
    accounts: accounts.map((account, index) => ({
      id: account.id || `account-${index + 1}`,
      email: account.email,
    })),
  };
  current.activeJob = job;
  try {
    await fetchJson("/api/oauth/auto-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: accounts.map((account) => `${account.email}|${account.password}|${account.totpSecret || ""}`),
        workers: workerCount,
        headed: Boolean(headed),
      }),
    }, 10_000);
    let rawStatus;
    const deadline = Date.now() + 3_000;
    do {
      rawStatus = await fetchJson("/api/oauth/auto-status");
      const resultEmails = new Set((rawStatus.results || []).map((result) => String(result.email || "").toLowerCase()));
      const accountEmails = new Set(job.accounts.map((account) => account.email.toLowerCase()));
      const belongsToJob = resultEmails.size === 0 || [...resultEmails].every((email) => accountEmails.has(email));
      if (belongsToJob && (rawStatus.running === true || resultEmails.size === 0 || rawStatus.total === job.accounts.length)) break;
      await sleep(100);
    } while (Date.now() < deadline);
    return mapJobStatus(rawStatus);
  } catch (error) {
    current.activeJob = null;
    throw error;
  }
}

export async function getPythonAutoLogin(jobId) {
  const current = state();
  if (!current.activeJob || current.activeJob.id !== jobId) throw new PythonServiceError("Job not found", 404);
  await ensurePythonService();
  return mapJobStatus(await fetchJson("/api/oauth/auto-status"));
}

export async function stopPythonAutoLogin(jobId) {
  const current = state();
  if (!current.activeJob || current.activeJob.id !== jobId) throw new PythonServiceError("Job not found", 404);
  await ensurePythonService();
  await fetchJson("/api/oauth/auto-stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, 10_000);
  const status = await fetchJson("/api/oauth/auto-status");
  return mapJobStatus({ ...status, stopped: true, running: false });
}

export function pythonServiceErrorStatus(error) {
  return Number.isInteger(error?.statusCode) ? error.statusCode : 502;
}

export { PythonServiceError };
