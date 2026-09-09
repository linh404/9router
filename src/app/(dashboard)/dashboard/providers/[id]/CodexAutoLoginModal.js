"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";
import {
  hasCodexTokenPair,
  parseCodexAccountFile,
} from "@/shared/utils/codexAccountFile";

const POLL_INTERVAL_MS = 750;

function parseCredentialFile(text) {
  const parsed = parseCodexAccountFile(text);
  if (!parsed.records.length) {
    const detail = parsed.errors.map((item) => item.error).filter(Boolean).join("; ");
    throw new Error(detail || "No valid Codex accounts found.");
  }
  return {
    accounts: parsed.records,
    skipped: parsed.errors.length,
    errors: parsed.errors,
  };
}

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

function resultStatus(result) {
  const value = String(result?.status || "").toLowerCase();
  if (value === "success" || value === "ok" || result?.ok === true) return "success";
  if (value === "pending" || value === "queued" || value === "running") return "running";
  return "error";
}

export default function CodexAutoLoginModal({ isOpen, onClose, onSuccess }) {
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountIndexes, setSelectedAccountIndexes] = useState([]);
  const [fileName, setFileName] = useState("");
  const [workers, setWorkers] = useState("3");
  const [headed, setHeaded] = useState(false);
  const [jobId, setJobId] = useState("");
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const pollTimerRef = useRef(null);
  const pollInFlightRef = useRef(false);
  const fileInputRef = useRef(null);

  const statusTotal = status?.total || accounts.length;
  const completed = (status?.done || 0) + (status?.failed || 0);
  const progress = statusTotal > 0 ? Math.min(100, Math.round((completed / statusTotal) * 100)) : 0;
  const statusComplete = Boolean(status?.stopped || status?.completed || (statusTotal > 0 && completed >= statusTotal && status?.running !== true));
  const running = Boolean(status?.running) || (busy && !statusComplete && !status?.completedAt);

  const clearPollTimer = () => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const reset = () => {
    clearPollTimer();
    setAccounts([]);
    setSelectedAccountIndexes([]);
    setFileName("");
    setJobId("");
    setStatus(null);
    setBusy(false);
    setStopping(false);
    setError("");
  };

  useEffect(() => () => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
  }, []);

  const pollStatus = async (currentJobId) => {
    if (!currentJobId || pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    try {
      const response = await fetch(`/api/oauth/codex/auto-login/status?jobId=${encodeURIComponent(currentJobId)}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `Status request failed (${response.status})`);

      const nextStatus = normalizeStatus(payload);
      setStatus(nextStatus);
      const nextCompleted = (nextStatus.done || 0) + (nextStatus.failed || 0);
      const isFinished = nextStatus.running === false
        || nextStatus.stopped === true
        || nextStatus.completed === true
        || (nextStatus.total > 0 && nextCompleted >= nextStatus.total && nextStatus.running !== true);
      if (isFinished) {
        clearPollTimer();
        setBusy(false);
        setStopping(false);
        if ((nextStatus.done || 0) > 0 && typeof onSuccess === "function") onSuccess();
      } else {
        pollTimerRef.current = setTimeout(() => pollStatus(currentJobId), POLL_INTERVAL_MS);
      }
    } catch (pollError) {
      clearPollTimer();
      setBusy(false);
      setStopping(false);
      setError(pollError?.message || "Failed to read auto-login status");
    } finally {
      pollInFlightRef.current = false;
    }
  };

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    try {
      const parsed = parseCredentialFile(await file.text());
      setAccounts(parsed.accounts);
      setSelectedAccountIndexes(parsed.accounts.map((_, index) => index));
      setFileName(file.name);
      if (parsed.skipped > 0) {
        const details = parsed.errors?.map((item) => item.error).filter(Boolean).join("; ");
        setError(`${parsed.skipped} record(s) skipped${details ? `: ${details}` : "."}`);
      }
      setStatus(null);
      setJobId("");
    } catch (fileError) {
      setAccounts([]);
      setSelectedAccountIndexes([]);
      setFileName(file.name);
      setError(fileError?.message || "Failed to read the selected file.");
    }
  };

  const toggleAccount = (index) => {
    setSelectedAccountIndexes((current) => (
      current.includes(index)
        ? current.filter((item) => item !== index)
        : [...current, index].sort((a, b) => a - b)
    ));
  };

  const selectAllAccounts = () => {
    setSelectedAccountIndexes(accounts.map((_, index) => index));
  };

  const clearAccountSelection = () => setSelectedAccountIndexes([]);

  const importTokenAccounts = async (selectedAccounts) => {
    setBusy(true);
    setStopping(false);
    setStatus({
      total: selectedAccounts.length,
      done: 0,
      failed: 0,
      running: true,
      results: [],
    });
    try {
      const response = await fetch("/api/oauth/codex/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: selectedAccounts.map((account) => account.raw) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `Token import failed (${response.status})`);

      const results = selectedAccounts.map((account, index) => {
        const item = Array.isArray(payload.results)
          ? payload.results.find((candidate) => candidate.index === index) || payload.results[index]
          : null;
        return {
          email: account.email,
          status: item?.ok ? "success" : "failed",
          ...(item?.error ? { error: item.error } : {}),
        };
      });
      const succeeded = results.filter((result) => result.status === "success").length;
      const failed = results.length - succeeded;
      setStatus({
        total: results.length,
        done: succeeded,
        succeeded,
        failed,
        cancelled: 0,
        running: false,
        completed: true,
        stopped: false,
        workersRunning: 0,
        workersRequested: 0,
        activeAccounts: [],
        results,
        accounts: results,
      });
      setAccounts([]);
      setSelectedAccountIndexes([]);
      setFileName("");
      if (succeeded > 0 && typeof onSuccess === "function") onSuccess();
    } catch (importError) {
      setStatus(null);
      setError(importError?.message || "Failed to import Codex tokens");
    } finally {
      setBusy(false);
    }
  };

  const handleStart = async () => {
    setError("");
    const selectedAccounts = selectedAccountIndexes
      .filter((index) => Number.isInteger(index) && index >= 0 && index < accounts.length)
      .map((index) => accounts[index]);
    if (selectedAccounts.length === 0) {
      setError("Choose at least one account from a JSON file.");
      return;
    }

    // Import JSON exports contain OAuth tokens and no plaintext password.  The
    // canonical file shape is shared with Auto Login, so route token-only
    // records through the existing bulk importer instead of trying to use a
    // token as a browser password.
    const tokenAccounts = selectedAccounts.filter((account) => hasCodexTokenPair(account) && !account.password);
    if (tokenAccounts.length > 0) {
      if (tokenAccounts.length !== selectedAccounts.length) {
        setError("Select either token records or email/password records; mixed selections are not supported in one run.");
        return;
      }
      await importTokenAccounts(tokenAccounts);
      return;
    }

    const workerCount = Number.parseInt(workers, 10);
    if (!Number.isInteger(workerCount) || workerCount < 1) {
      setError("Workers must be a positive integer.");
      return;
    }

    setBusy(true);
    setStopping(false);
    setStatus({ total: selectedAccounts.length, done: 0, failed: 0, running: true, results: [] });
    try {
      const response = await fetch("/api/oauth/codex/auto-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accounts: selectedAccounts,
          workers: workerCount,
          headed,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `Start request failed (${response.status})`);

      const nextJobId = payload?.jobId || payload?.id || payload?.job?.id;
      if (!nextJobId) throw new Error("Auto-login did not return a job id.");
      setJobId(String(nextJobId));
      setAccounts([]);
      setSelectedAccountIndexes([]);
      setFileName("");
      const initialStatus = normalizeStatus({ ...payload, total: payload.total || selectedAccounts.length, running: true });
      setStatus(initialStatus);
      pollStatus(String(nextJobId));
    } catch (startError) {
      setBusy(false);
      setStatus(null);
      setError(startError?.message || "Failed to start auto-login");
    }
  };

  const handleStop = async () => {
    if (!jobId || stopping) return;
    setStopping(true);
    setError("");
    try {
      const response = await fetch("/api/oauth/codex/auto-login/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `Stop request failed (${response.status})`);
      setStatus((previous) => ({ ...previous, ...(normalizeStatus(payload)), stopped: true, running: false }));
      clearPollTimer();
      setBusy(false);
      setStopping(false);
    } catch (stopError) {
      setStopping(false);
      setError(stopError?.message || "Failed to stop auto-login");
    }
  };

  const handleClose = () => {
    if (running || stopping) return;
    reset();
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      title="Codex Auto Login"
      onClose={handleClose}
      closeOnOverlay={!running}
      size="xl"
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">
          Load the same Codex JSON used by Import JSON. Credential records are signed in with Playwright; token records are imported directly. Passwords and tokens are never shown in results.
        </p>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
          <div className="flex min-w-0 flex-col gap-2 text-xs font-medium text-text-main">
            <span>Account file</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.jsonl,application/json"
              className="hidden"
              onChange={handleFileChange}
              disabled={running}
            />
            <div className="flex min-w-0 items-center gap-2">
              <Button
                variant="secondary"
                icon="upload_file"
                onClick={() => fileInputRef.current?.click()}
                disabled={running}
              >
                Choose JSON file
              </Button>
              <span className="min-w-0 truncate font-normal text-text-muted" title={fileName}>
                {fileName || "No file selected"}
              </span>
            </div>
            <span className="font-normal text-text-muted">
              {accounts.length} account{accounts.length === 1 ? "" : "s"} loaded. JSON arrays, {"{accounts: [...] }"}, and JSONL are supported.
            </span>
          </div>

          <label className="flex flex-col gap-1.5 text-xs font-medium text-text-main">
            Workers
            <input
              type="number"
              min="1"
              max="32"
              step="1"
              value={workers}
              onChange={(event) => setWorkers(event.target.value)}
              disabled={running}
              className="h-9 w-24 rounded-lg border border-border bg-background px-2 text-sm outline-none focus:border-primary disabled:opacity-60"
            />
          </label>

          <label className="flex items-center gap-2 pb-2 text-xs text-text-muted sm:whitespace-nowrap">
            <input
              type="checkbox"
              checked={headed}
              onChange={(event) => setHeaded(event.target.checked)}
              disabled={running}
              className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
            />
            Show browser windows
          </label>
        </div>

        {accounts.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-2 p-3">
            <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
              <span>{selectedAccountIndexes.length}/{accounts.length} selected</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="text-primary underline disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={selectAllAccounts}
                  disabled={selectedAccountIndexes.length === accounts.length || running}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="underline disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={clearAccountSelection}
                  disabled={selectedAccountIndexes.length === 0 || running}
                >
                  Select none
                </button>
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto rounded border border-border-subtle">
              {accounts.map((account, index) => (
                <label
                  key={`${account.email}-${index}`}
                  className="flex cursor-pointer items-center gap-2 border-b border-border-subtle px-3 py-2 text-xs last:border-b-0"
                >
                  <input
                    type="checkbox"
                    checked={selectedAccountIndexes.includes(index)}
                    onChange={() => toggleAccount(index)}
                    disabled={running}
                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  />
                  <span className="min-w-0 truncate text-text-main">{account.email}</span>
                  {(account.totpSecret || hasCodexTokenPair(account)) && (
                    <span className="ml-auto shrink-0 text-text-muted">
                      {[account.totpSecret && "2FA", hasCodexTokenPair(account) && "Tokens"].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </label>
              ))}
            </div>
          </div>
        )}

        {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

        {(status || busy) && (
          <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
              <span>{status?.stopped ? "Stopped" : running ? "Running" : "Finished"}</span>
              <span>{completed}/{statusTotal} completed{status?.workersRunning ? ` · ${status.workersRunning}/${status.workersRequested || status.workersRunning} workers` : ""}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} />
            </div>
            {status?.currentEmail && (
              <p className="mt-2 truncate text-xs text-text-muted">Current: {status.currentEmail}</p>
            )}
            {status?.activeAccounts?.length > 0 && (
              <p className="mt-1 truncate text-xs text-text-muted">Active: {status.activeAccounts.join(" · ")}</p>
            )}
          </div>
        )}

        {status?.results?.length > 0 && (
          <div className="max-h-56 overflow-y-auto rounded-lg border border-border-subtle">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-border-subtle bg-surface-2 px-3 py-2 text-xs font-semibold text-text-muted">
              <span>Account</span>
              <span>Result</span>
            </div>
            {status.results.map((result, index) => {
              const state = resultStatus(result);
              return (
                <div key={`${result.email || "account"}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-border-subtle px-3 py-2 text-xs last:border-b-0">
                  <div className="min-w-0">
                    <div className="truncate text-text-main">{result.email || "Unknown account"}</div>
                    {result.error && <div className="mt-0.5 break-words text-red-600 dark:text-red-400">{result.error}</div>}
                  </div>
                  <span className={state === "success" ? "text-green-600 dark:text-green-400" : state === "running" ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"}>
                    {state === "success" ? "Success" : state === "running" ? (String(result.status).toLowerCase() === "queued" ? "Queued" : "Running") : "Failed"}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={handleClose} disabled={running || stopping}>Close</Button>
          {running ? (
            <Button variant="danger" icon="stop" onClick={handleStop} loading={stopping}>Stop Auto Login</Button>
          ) : (
            <Button
              icon="rocket_launch"
              onClick={handleStart}
              loading={busy}
              disabled={accounts.length === 0 || selectedAccountIndexes.length === 0}
            >
              Start Auto Login
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

CodexAutoLoginModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSuccess: PropTypes.func,
};
