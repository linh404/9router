"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button, ConfirmModal, Modal } from "@/shared/components";
import { hasCodexTokenPair, parseCodexAccountFile } from "@/shared/utils/codexAccountFile";

const POLL_INTERVAL_MS = 750;

function normalizeStatus(payload) {
  const status = payload?.status && typeof payload.status === "object"
    ? payload.status
    : payload?.job && typeof payload.job === "object"
      ? payload.job
      : payload || {};
  return {
    ...status,
    results: Array.isArray(status.results) ? status.results : [],
    total: Number(status.total) || 0,
    done: Number(status.done) || 0,
    failed: Number(status.failed) || 0,
    activeAccounts: Array.isArray(status.activeAccounts) ? status.activeAccounts : [],
  };
}

function loginResultStatus(result) {
  const value = String(result?.status || "").toLowerCase();
  if (value === "success" || value === "ok" || result?.ok === true) return "success";
  if (value === "pending" || value === "queued" || value === "running") return "running";
  return "error";
}

function accountLabel(account) {
  return account?.email || account?.name || account?.id || "Unknown account";
}

export default function CodexAutoLoginV2Modal({ isOpen, onClose, onSuccess, connections }) {
  const [accounts, setAccounts] = useState([]);
  const [fileName, setFileName] = useState("");
  const [workers, setWorkers] = useState("3");
  const [headed, setHeaded] = useState(false);
  const [checkResults, setCheckResults] = useState([]);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [loginStatus, setLoginStatus] = useState(null);
  const [loginJobId, setLoginJobId] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [confirmLoginOpen, setConfirmLoginOpen] = useState(false);
  const fileInputRef = useRef(null);
  const pollTimerRef = useRef(null);
  const pollInFlightRef = useRef(false);

  const failedResults = useMemo(
    () => checkResults.filter((result) => result.valid !== true),
    [checkResults]
  );
  const statusTotal = loginStatus?.total || 0;
  const completed = (loginStatus?.done || 0) + (loginStatus?.failed || 0);
  const progress = statusTotal > 0 ? Math.min(100, Math.round((completed / statusTotal) * 100)) : 0;
  const loginComplete = Boolean(
    loginStatus?.stopped
      || loginStatus?.completed
      || (statusTotal > 0 && completed >= statusTotal && loginStatus?.running !== true)
  );
  const loginRunning = Boolean(loginStatus?.running) || (loginBusy && !loginComplete && !loginStatus?.completedAt);

  const clearPollTimer = () => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const reset = () => {
    clearPollTimer();
    setAccounts([]);
    setFileName("");
    setCheckResults([]);
    setChecking(false);
    setCheckError("");
    setLoginStatus(null);
    setLoginJobId("");
    setLoginBusy(false);
    setStopping(false);
    setLoginError("");
    setConfirmLoginOpen(false);
  };

  useEffect(() => () => clearPollTimer(), []);

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setCheckError("");
    setLoginError("");
    setCheckResults([]);
    try {
      const parsed = parseCodexAccountFile(await file.text());
      if (!parsed.records.length) {
        const detail = parsed.errors.map((item) => item.error).filter(Boolean).join("; ");
        throw new Error(detail || "No valid Codex accounts found.");
      }
      setAccounts(parsed.records);
      setFileName(file.name);
      if (parsed.errors.length > 0) {
        const detail = parsed.errors.map((item) => item.error).filter(Boolean).join("; ");
        setCheckError(`${parsed.errors.length} record(s) skipped${detail ? `: ${detail}` : "."}`);
      }
    } catch (error) {
      setAccounts([]);
      setFileName(file.name);
      setCheckError(error?.message || "Failed to read the selected file.");
    }
  };

  const handleCheck = async () => {
    if (!connections.length) {
      setCheckError("There are no Codex connections to check.");
      return;
    }
    if (!accounts.length) {
      setCheckError("Choose the Codex JSON file first so failed connections can be matched for login.");
      return;
    }
    setChecking(true);
    setCheckError("");
    setLoginError("");
    setCheckResults([]);
    try {
      const connectionPayload = connections.map(({ id, email, name }) => ({ id, email, name }));
      const response = await fetch("/api/oauth/codex/auto-login-v2/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connections: connectionPayload,
          connectionIds: connectionPayload.map((connection) => connection.id),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `Check request failed (${response.status})`);
      if (!Array.isArray(payload.results)) throw new Error("Check response did not include account results.");
      setCheckResults(payload.results);
    } catch (error) {
      setCheckError(error?.message || "Failed to check Codex connections.");
    } finally {
      setChecking(false);
    }
  };

  const matchedFailedAccounts = useMemo(() => {
    const byEmail = new Map();
    const byAccountId = new Map();
    accounts.forEach((account) => {
      const email = String(account.email || "").toLowerCase();
      if (email) byEmail.set(email, [...(byEmail.get(email) || []), account]);
      const accountId = account.tokens?.account_id;
      if (accountId) byAccountId.set(String(accountId), [...(byAccountId.get(String(accountId)) || []), account]);
    });
    return failedResults.map((result) => {
      const accountId = result.chatgptAccountId || result.accountId || result.chatgpt_account_id;
      const idMatches = accountId ? (byAccountId.get(String(accountId)) || []) : [];
      const emailMatches = byEmail.get(String(result.email || "").toLowerCase()) || [];
      const candidates = idMatches.length > 0 ? idMatches : emailMatches;
      const match = candidates.length === 1 ? candidates[0] : null;
      return {
        result,
        account: match,
        usable: Boolean(match?.password),
        ambiguous: candidates.length > 1,
      };
    });
  }, [accounts, failedResults]);

  const pollStatus = async (currentJobId) => {
    if (!currentJobId || pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    try {
      const response = await fetch(`/api/oauth/codex/auto-login/status?jobId=${encodeURIComponent(currentJobId)}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `Status request failed (${response.status})`);
      const nextStatus = normalizeStatus(payload);
      setLoginStatus(nextStatus);
      const nextCompleted = (nextStatus.done || 0) + (nextStatus.failed || 0);
      const finished = nextStatus.running === false
        || nextStatus.stopped === true
        || nextStatus.completed === true
        || (nextStatus.total > 0 && nextCompleted >= nextStatus.total && nextStatus.running !== true);
      if (finished) {
        clearPollTimer();
        setLoginBusy(false);
        setStopping(false);
        if ((nextStatus.done || 0) > 0 && typeof onSuccess === "function") onSuccess();
      } else {
        pollTimerRef.current = setTimeout(() => pollStatus(currentJobId), POLL_INTERVAL_MS);
      }
    } catch (error) {
      clearPollTimer();
      setLoginBusy(false);
      setStopping(false);
      setLoginError(error?.message || "Failed to read auto-login status");
    } finally {
      pollInFlightRef.current = false;
    }
  };

  const handleLoginAgain = async () => {
    const usableAccounts = matchedFailedAccounts
      .filter(({ usable }) => usable)
      .map(({ account }) => ({
        email: account.email,
        password: account.password,
        totpSecret: account.totpSecret || "",
      }));
    if (!usableAccounts.length) {
      setLoginError("No failed account has a matching email/password record in the selected file.");
      return;
    }
    const workerCount = Number.parseInt(workers, 10);
    if (!Number.isInteger(workerCount) || workerCount < 1) {
      setLoginError("Workers must be a positive integer.");
      return;
    }
    setLoginBusy(true);
    setStopping(false);
    setLoginError("");
    setLoginStatus({ total: usableAccounts.length, done: 0, failed: 0, running: true, results: [] });
    try {
      const response = await fetch("/api/oauth/codex/auto-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: usableAccounts, workers: workerCount, headed }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `Start request failed (${response.status})`);
      const nextJobId = payload?.jobId || payload?.id || payload?.job?.id;
      if (!nextJobId) throw new Error("Auto-login did not return a job id.");
      setLoginJobId(String(nextJobId));
      const initialStatus = normalizeStatus({ ...payload, total: payload.total || usableAccounts.length, running: true });
      setLoginStatus(initialStatus);
      pollStatus(String(nextJobId));
    } catch (error) {
      setLoginBusy(false);
      setLoginStatus(null);
      setLoginError(error?.message || "Failed to start auto-login");
    }
  };

  const handleStop = async () => {
    if (!loginJobId || stopping) return;
    setStopping(true);
    setLoginError("");
    try {
      const response = await fetch("/api/oauth/codex/auto-login/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: loginJobId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `Stop request failed (${response.status})`);
      setLoginStatus((previous) => ({ ...previous, ...normalizeStatus(payload), stopped: true, running: false }));
      clearPollTimer();
      setLoginBusy(false);
      setStopping(false);
    } catch (error) {
      setStopping(false);
      setLoginError(error?.message || "Failed to stop auto-login");
    }
  };

  const handleClose = () => {
    if (checking || loginRunning || stopping) return;
    reset();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} title="Codex Auto Login v2" onClose={handleClose} closeOnOverlay={!checking && !loginRunning} size="xl">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">
          Check every saved Codex connection, then sign in again only for accounts that need it. Passwords and tokens are never shown.
        </p>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
          <div className="flex min-w-0 flex-col gap-2 text-xs font-medium text-text-main">
            <span>Account file for failed accounts</span>
            <input ref={fileInputRef} type="file" accept=".json,.jsonl,application/json" className="hidden" onChange={handleFileChange} disabled={loginRunning || checking} />
            <div className="flex min-w-0 items-center gap-2">
              <Button variant="secondary" icon="upload_file" onClick={() => fileInputRef.current?.click()} disabled={loginRunning || checking}>Choose JSON file</Button>
              <span className="min-w-0 truncate font-normal text-text-muted" title={fileName}>{fileName || "No file selected"}</span>
            </div>
            <span className="font-normal text-text-muted">{accounts.length} account{accounts.length === 1 ? "" : "s"} loaded.</span>
          </div>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-text-main">
            Workers
            <input type="number" min="1" max="32" step="1" value={workers} onChange={(event) => setWorkers(event.target.value)} disabled={loginRunning || checking} className="h-9 w-24 rounded-lg border border-border bg-background px-2 text-sm outline-none focus:border-primary disabled:opacity-60" />
          </label>
          <label className="flex items-center gap-2 pb-2 text-xs text-text-muted sm:whitespace-nowrap">
            <input type="checkbox" checked={headed} onChange={(event) => setHeaded(event.target.checked)} disabled={loginRunning || checking} className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary" />
            Show browser windows
          </label>
        </div>

        {checkError && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{checkError}</p>}
        {loginError && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{loginError}</p>}

        {(checking || checkResults.length > 0) && (
          <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
              <span>{checking ? "Checking Codex connections..." : "Connection check complete"}</span>
              <span>{checkResults.length}/{connections.length} checked</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
              <div className={`h-full rounded-full bg-primary transition-all ${checking ? "animate-pulse" : ""}`} style={{ width: `${checking ? 35 : 100}%` }} />
            </div>
          </div>
        )}

        {checkResults.length > 0 && (
          <div className="max-h-56 overflow-y-auto rounded-lg border border-border-subtle">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-border-subtle bg-surface-2 px-3 py-2 text-xs font-semibold text-text-muted"><span>Account</span><span>Result</span></div>
            {checkResults.map((result, index) => (
              <div key={`${result.id || result.email || "account"}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-border-subtle px-3 py-2 text-xs last:border-b-0">
                <div className="min-w-0"><div className="truncate text-text-main">{accountLabel(result)}</div>{result.error && <div className="mt-0.5 break-words text-red-600 dark:text-red-400">{result.error}</div>}</div>
                <span className={result.valid ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>{result.valid ? (result.refreshed ? "Valid / refreshed" : "Valid") : "Needs login"}</span>
              </div>
            ))}
          </div>
        )}

        {!checking && checkResults.length > 0 && failedResults.length === 0 && (
          <p className="rounded-lg bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">All Codex connections are valid. No login is needed.</p>
        )}

        {!checking && failedResults.length > 0 && !loginRunning && !loginComplete && (
          <div className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <div><p className="text-sm font-semibold text-text-main">{failedResults.length} account{failedResults.length === 1 ? "" : "s"} need login again</p><p className="mt-1 text-xs text-text-muted">Confirm to run Auto Login only for failed accounts with matching email/password records.</p></div>
            <div className="max-h-32 overflow-y-auto rounded border border-amber-500/20 bg-background/40 px-3 py-2 text-xs text-text-main">
              {matchedFailedAccounts.map(({ result, account, usable, ambiguous }, index) => <div key={`${result.id || result.email || index}`} className="flex items-center justify-between gap-2 py-1"><span className="min-w-0 truncate">{accountLabel(result)}</span><span className={usable ? "text-amber-700 dark:text-amber-300" : "text-red-600 dark:text-red-400"}>{usable ? "Ready" : ambiguous ? "Duplicate file match" : account ? (hasCodexTokenPair(account) ? "Token-only file record" : "Missing password") : "Not in file"}</span></div>)}
            </div>
            <Button icon="rocket_launch" onClick={() => setConfirmLoginOpen(true)}>Confirm and Login Again</Button>
          </div>
        )}

        {loginStatus && (
          <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted"><span>{loginStatus.stopped ? "Stopped" : loginRunning ? "Logging in..." : "Login finished"}</span><span>{completed}/{statusTotal} completed</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/10"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} /></div>
            {loginStatus.activeAccounts?.length > 0 && <p className="mt-2 truncate text-xs text-text-muted">Active: {loginStatus.activeAccounts.join(" · ")}</p>}
            {loginStatus.results?.length > 0 && <div className="mt-3 flex flex-col gap-1 text-xs">{loginStatus.results.map((result, index) => <div key={`${result.email || index}`} className="flex justify-between gap-2"><span className="truncate">{result.email || "Unknown account"}</span><span className={loginResultStatus(result) === "success" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>{loginResultStatus(result) === "success" ? "Success" : "Failed"}</span></div>)}</div>}
          </div>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={handleClose} disabled={checking || loginRunning || stopping}>Close</Button>
          {loginRunning ? <Button variant="danger" icon="stop" onClick={handleStop} loading={stopping}>Stop Auto Login</Button> : <Button icon="sync" onClick={handleCheck} loading={checking} disabled={connections.length === 0 || accounts.length === 0}>Check All Connections</Button>}
        </div>
      </div>
      <ConfirmModal
        isOpen={confirmLoginOpen}
        onClose={() => setConfirmLoginOpen(false)}
        onConfirm={async () => {
          setConfirmLoginOpen(false);
          await handleLoginAgain();
        }}
        title="Login failed Codex accounts again?"
        message={`This will run Auto Login for ${matchedFailedAccounts.filter(({ usable }) => usable).length} matched account(s). Accounts without a password record will be skipped.`}
        confirmText="Login Again"
        cancelText="Cancel"
        variant="danger"
      />
    </Modal>
  );
}

CodexAutoLoginV2Modal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSuccess: PropTypes.func,
  connections: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string })).isRequired,
};
