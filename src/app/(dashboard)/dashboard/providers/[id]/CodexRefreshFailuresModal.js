"use client";

import PropTypes from "prop-types";
import { Modal } from "@/shared/components";

function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown time";
}

export default function CodexRefreshFailuresModal({ isOpen, connection, onClose }) {
  const failures = Array.isArray(connection?.providerSpecificData?.codexRefreshFailures)
    ? [...connection.providerSpecificData.codexRefreshFailures].reverse()
    : [];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Codex refresh errors${connection?.name ? `: ${connection.name}` : ""}`}
      size="lg"
    >
      {failures.length === 0 ? (
        <p className="text-sm text-text-muted">No refresh errors recorded.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {failures.map((failure, index) => (
            <div key={`${failure.at || "unknown"}-${index}`} className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                <span>{formatDate(failure.at)}</span>
                <span>{failure.source === "manual" ? "Manual refresh" : "Automatic refresh"}</span>
                {failure.code && <span>Code: {failure.code}</span>}
                {failure.status && <span>Status: {failure.status}</span>}
              </div>
              <p className="mt-1 break-words text-sm text-red-600 dark:text-red-400">{failure.message}</p>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

CodexRefreshFailuresModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connection: PropTypes.shape({
    name: PropTypes.string,
    providerSpecificData: PropTypes.shape({
      codexRefreshFailures: PropTypes.arrayOf(PropTypes.shape({
        at: PropTypes.string,
        source: PropTypes.string,
        message: PropTypes.string,
        code: PropTypes.string,
        status: PropTypes.number,
      })),
    }),
  }),
  onClose: PropTypes.func.isRequired,
};
