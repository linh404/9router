"use client";

import { useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";
import { translate } from "@/i18n/runtime";

const PLACEHOLDER = `{
    "2fa": null,
    "OPENAI_API_KEY": null,
    "email": "user@example.com",
    "last_refresh": "2026-09-01T00:00:00Z",
    "password": null,
    "tokens": {
      "access_token": "eyJhbGc...",
      "account_id": "00000000-0000-0000-0000-000000000000",
      "id_token": "eyJhbGc...",
      "refresh_token": "rt_..."
    }
}`;

// Same caps as the standalone importer GUI (32 MiB JSON body, ~24 MiB ZIP).
const MAX_ZIP_BYTES = 24 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    r.readAsText(file);
  });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = String(r.result || "");
      resolve(result.slice(result.indexOf(",") + 1)); // strip data: URL prefix
    };
    r.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    r.readAsDataURL(file);
  });
}

// webkitdirectory entries carry the relative path in webkitRelativePath.
function fileKey(file) {
  return `${file.webkitRelativePath || ""}/${file.name}`;
}

function isAccepted(file) {
  const n = file.name.toLowerCase();
  return n.endsWith(".json") || n.endsWith(".zip");
}

export default function BulkImportCodexModal({ isOpen, onClose, onSuccess }) {
  const [tab, setTab] = useState("files"); // "files" | "paste"
  const [files, setFiles] = useState([]); // Map-like array of { key, name, size, text?, zip? }
  const [jsonText, setJsonText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(""); // "" | "parsing" | "importing"
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null); // { accounts, preview, errors }
  const [result, setResult] = useState(null);
  const dropRef = useRef(null);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  const reset = () => {
    setFiles([]);
    setJsonText("");
    setError("");
    setPreview(null);
    setResult(null);
    setBusy("");
  };

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const addFiles = async (list) => {
    setError("");
    const accepted = Array.from(list).filter(isAccepted);
    if (accepted.length === 0) return;

    const loaded = [];
    for (const f of accepted) {
      const key = fileKey(f);
      if (files.some((x) => x.key === key)) continue;
      try {
        if (f.name.toLowerCase().endsWith(".zip")) {
          if (f.size > MAX_ZIP_BYTES) {
            setError(`${f.name}: ZIP > ${Math.floor(MAX_ZIP_BYTES / 1024 / 1024)} MiB — extract it and import the JSON files directly`);
            continue;
          }
          loaded.push({ key, name: key, size: f.size, zip: await readFileAsBase64(f) });
        } else {
          if (f.size > MAX_JSON_BYTES) {
            setError(`${f.name}: JSON > ${Math.floor(MAX_JSON_BYTES / 1024 / 1024)} MiB — skipped`);
            continue;
          }
          loaded.push({ key, name: key, size: f.size, text: await readFileAsText(f) });
        }
      } catch (err) {
        setError(err.message);
      }
    }
    if (loaded.length) {
      setFiles((prev) => [...prev, ...loaded]);
      setPreview(null);
      setResult(null);
    }
  };

  const removeFile = (key) => {
    setFiles((prev) => prev.filter((f) => f.key !== key));
    setPreview(null);
    setResult(null);
  };

  const handleParse = async () => {
    setError("");
    setPreview(null);
    setResult(null);
    if (files.length === 0) return;
    setBusy("parsing");
    try {
      const res = await fetch("/api/oauth/codex/parse-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: files.map(({ name, text, zip }) => ({ name, text, zip })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      setPreview(data);
    } catch (err) {
      setError(err.message || translate("Request failed"));
    } finally {
      setBusy("");
    }
  };

  const handleImportAccounts = async (accounts) => {
    setBusy("importing");
    setError("");
    try {
      const res = await fetch("/api/oauth/codex/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      setResult(data);
      if (data.success > 0 && typeof onSuccess === "function") onSuccess();
    } catch (err) {
      setError(err.message || translate("Request failed"));
    } finally {
      setBusy("");
    }
  };

  const handleImportFiles = () => {
    if (!preview?.accounts?.length) return;
    handleImportAccounts(preview.accounts);
  };

  const handleImportPaste = async () => {
    setError("");
    setResult(null);
    const trimmed = jsonText.trim();
    if (!trimmed) return;
    setBusy("parsing");
    try {
      // Use the same server parser as file uploads.  Besides ordinary JSON
      // arrays/objects this accepts native Codex JSONL and pretty-printed
      // adjacent objects (the exact export format used by Codex tooling).
      const parseRes = await fetch("/api/oauth/codex/parse-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: [{ name: "pasted-codex.json", text: trimmed }] }),
      });
      const parsed = await parseRes.json();
      if (!parseRes.ok) throw new Error(parsed?.error || `Request failed: ${parseRes.status}`);
      const accounts = parsed?.accounts || [];
      if (accounts.length === 0) {
        const detail = parsed?.errors?.map((entry) => entry.error).filter(Boolean).join("; ");
        throw new Error(detail || translate("No accounts found in input"));
      }
      await handleImportAccounts(accounts);
    } catch (err) {
      setError(err.message || translate("Request failed"));
    } finally {
      setBusy("");
    }
  };

  const failedItems = result?.results?.filter((r) => !r.ok) || [];
  const parseErrors = preview?.errors || [];

  return (
    <Modal isOpen={isOpen} title={translate("Bulk Add Codex Accounts")} onClose={handleClose}>
      <div className="flex flex-col gap-4">
        {/* Tab switch */}
        <div className="flex gap-1 rounded-lg bg-sidebar p-1 text-sm">
          {[
            { id: "files", label: translate("Import Files") },
            { id: "paste", label: translate("Paste JSON") },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => { setTab(t.id); setError(""); }}
              className={`flex-1 rounded-md px-3 py-1.5 transition-colors ${
                tab === t.id ? "bg-primary text-white" : "text-text-muted hover:text-text"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "files" && (
          <>
            <p className="text-xs text-text-muted">
              {translate(
                "Drop ChatGPT/Codex OAuth JSON files (one account each), a .zip bundle, or a whole folder. Tokens are parsed and previewed before anything is written."
              )}
            </p>

            {/* Drop zone */}
            <div
              ref={dropRef}
              role="button"
              tabIndex={0}
              aria-label={translate("Drop JSON / ZIP files or a folder")}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const dt = e.dataTransfer;
                if (dt?.items?.length) {
                  // Folder drops need webkitGetAsEntry traversal
                  const entries = Array.from(dt.items)
                    .map((i) => i.webkitGetAsEntry?.())
                    .filter(Boolean);
                  if (entries.length) {
                    (async () => {
                      const out = [];
                      const walk = async (entry) => {
                        if (entry.isFile) {
                          const file = await new Promise((res) => entry.file(res));
                          out.push(file);
                        } else if (entry.isDirectory) {
                          const reader = entry.createReader();
                          // readEntries returns in batches of 100
                          let batch;
                          do {
                            batch = await new Promise((res) => reader.readEntries(res));
                            for (const e of batch) await walk(e);
                          } while (batch.length);
                        }
                      };
                      for (const en of entries) await walk(en);
                      await addFiles(out);
                    })();
                    return;
                  }
                }
                if (dt?.files?.length) addFiles(dt.files);
              }}
              className={`rounded-lg border-2 border-dashed p-6 text-center text-sm transition-colors cursor-pointer ${
                dragOver
                  ? "border-primary bg-primary/5"
                  : "border-accent/30 hover:border-accent/60"
              }`}
            >
              <span className="font-medium text-text">{translate("Drop files here")}</span>{" "}
              <span className="text-text-muted">
                {translate("or click to select · .json / .zip")}
              </span>
              <div className="mt-1">
                <button
                  type="button"
                  className="text-xs text-primary underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    folderInputRef.current?.click();
                  }}
                >
                  {translate("Select folder")}
                </button>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.zip,application/json,application/zip"
              multiple
              className="hidden"
              onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              webkitdirectory=""
              directory=""
              className="hidden"
              onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
            />

            {/* Selected files */}
            {files.length > 0 && (
              <ul className="max-h-32 overflow-y-auto rounded border border-accent/20 bg-sidebar/50 p-2 text-xs font-mono">
                {files.map((f) => (
                  <li key={f.key} className="flex items-center gap-2 py-0.5">
                    <span className="flex-1 truncate" title={f.name}>
                      {f.name}{" "}
                      <span className="text-text-muted">({Math.round(f.size / 1024)} KB)</span>
                    </span>
                    <button
                      type="button"
                      className="text-text-muted hover:text-red-400"
                      title={translate("Remove")}
                      onClick={() => removeFile(f.key)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex gap-2">
              <Button
                onClick={handleParse}
                fullWidth
                disabled={busy !== "" || files.length === 0}
              >
                {busy === "parsing" ? translate("Checking...") : translate("Check Tokens")}
              </Button>
              <Button
                onClick={() => { setFiles([]); setPreview(null); setResult(null); }}
                variant="ghost"
                disabled={busy !== "" || files.length === 0}
              >
                {translate("Clear")}
              </Button>
            </div>

            {/* Parse preview */}
            {preview && (
              <div className="flex flex-col gap-2">
                <div className="text-sm font-medium">
                  {preview.accounts.length > 0 ? (
                    <span className="text-green-400">
                      ✓ {preview.accounts.length} {translate("valid account(s)")}
                    </span>
                  ) : (
                    <span className="text-red-400">✗ {translate("No valid accounts found")}</span>
                  )}
                  {parseErrors.length > 0 && (
                    <span className="ml-2 text-yellow-400">
                      ⚠ {parseErrors.length} {translate("error(s)")}
                    </span>
                  )}
                </div>
                {preview.preview?.length > 0 && (
                  <div className="max-h-48 overflow-y-auto rounded border border-accent/20">
                    <table className="w-full text-xs">
                      <thead className="bg-sidebar text-left text-text-muted">
                        <tr>
                          <th className="p-1.5">{translate("File")}</th>
                          <th className="p-1.5">Email</th>
                          <th className="p-1.5">{translate("Expires")}</th>
                          <th className="p-1.5">{translate("Status")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.preview.map((row, i) => (
                          <tr key={i} className="border-t border-accent/10">
                            <td className="max-w-[14rem] truncate p-1.5 font-mono" title={row.name}>
                              {row.name}
                            </td>
                            <td className="p-1.5">{row.email || "—"}</td>
                            <td className="p-1.5 whitespace-nowrap">
                              {row.expiresAt ? new Date(row.expiresAt).toLocaleDateString() : "—"}
                            </td>
                            <td className="p-1.5 text-green-400">
                              OK · refresh…{row.refreshTail}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {parseErrors.length > 0 && (
                  <ul className="max-h-32 overflow-y-auto rounded border border-accent/20 bg-sidebar/50 p-2 text-xs font-mono">
                    {parseErrors.map((e, i) => (
                      <li key={i} className="text-red-400">
                        [{e.name}] {e.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}

        {tab === "paste" && (
          <>
            <p className="text-xs text-text-muted">
              {translate(
                "Paste an array of codex account JSON objects. Each must include accessToken (and ideally refreshToken, idToken)."
              )}
            </p>
            <textarea
              className="w-full rounded border border-accent/30 bg-sidebar p-2 text-sm font-mono resize-y min-h-[240px] focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder={PLACEHOLDER}
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              disabled={busy !== ""}
            />
          </>
        )}

        {error && <p className="text-xs text-red-500 break-words">{error}</p>}

        {result && (
          <div className="flex flex-col gap-2">
            <div
              className={`text-sm font-medium ${
                result.failed > 0 ? "text-yellow-400" : "text-green-400"
              }`}
            >
              ✓ {result.success} {translate("added")}
              {result.failed > 0 ? `, ✗ ${result.failed} ${translate("failed")}` : ""}
            </div>
            {failedItems.length > 0 && (
              <ul className="rounded border border-accent/20 bg-sidebar/50 p-2 text-xs font-mono max-h-40 overflow-y-auto">
                {failedItems.map((item) => (
                  <li key={item.index} className="text-red-400">
                    [{item.index}] {item.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex gap-2">
          {tab === "files" ? (
            <Button
              onClick={handleImportFiles}
              fullWidth
              disabled={busy !== "" || !preview?.accounts?.length}
            >
              {busy === "importing" ? translate("Importing...") : translate("Import All")}
            </Button>
          ) : (
            <Button
              onClick={handleImportPaste}
              fullWidth
              disabled={busy !== "" || !jsonText.trim()}
            >
              {busy === "importing" ? translate("Importing...") : translate("Import All")}
            </Button>
          )}
          <Button onClick={handleClose} variant="ghost" fullWidth disabled={busy !== ""}>
            {translate("Close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

BulkImportCodexModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSuccess: PropTypes.func,
};
