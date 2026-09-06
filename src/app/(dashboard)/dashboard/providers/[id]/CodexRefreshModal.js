"use client";

import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";

export default function CodexRefreshModal({ isOpen, loading, onClose, onRefresh }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Refresh Codex tokens" size="sm">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">
          Refresh all Codex OAuth connections. Rotated refresh tokens are returned
          by Codex and must be saved somewhere safe.
        </p>
        <div className="grid gap-2">
          <Button
            fullWidth
            icon="database"
            disabled={loading}
            onClick={() => onRefresh("db")}
          >
            Refresh and overwrite DB
          </Button>
          <Button
            fullWidth
            variant="secondary"
            icon="download"
            disabled={loading}
            onClick={() => onRefresh("json")}
          >
            Refresh and download JSON
          </Button>
        </div>
        {loading && (
          <p className="text-xs text-text-muted">Refreshing every Codex connection...</p>
        )}
      </div>
    </Modal>
  );
}

CodexRefreshModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  loading: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onRefresh: PropTypes.func.isRequired,
};
