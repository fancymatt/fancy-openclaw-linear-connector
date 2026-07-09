/**
 * AI-1954 — OpsActions: redispatch / set-state / recapture-ac / deploy buttons
 * for the management console ticket-detail and fleet views.
 *
 * AC4: buttons with confirmation dialogs; unauthorized session surfaces error.
 * AC5: deploy button present; disabled-with-reason (deploy-policy ci_auto_deploy:false).
 */
import { useState } from "react";
import { apiPost, UnauthorizedError } from "../api";

export interface OpsActionsProps {
  ticketId: string;
  /** Console session username used as the invoker identity for audit attribution. */
  invoker: string;
  /**
   * "full" (default) renders redispatch + set-state + recapture-ac + deploy —
   * used on the ticket-detail view. "redispatch" renders only the Redispatch
   * action, for per-row use on the fleet page (ticket scope: fleet = redispatch).
   */
  variant?: "full" | "redispatch";
}

type DialogKind = "redispatch" | "set-state" | "recapture-ac" | null;

export function OpsActions({ ticketId, invoker, variant = "full" }: OpsActionsProps) {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [targetState, setTargetState] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function openDialog(kind: DialogKind) {
    setDialog(kind);
    setTargetState("");
    setReason("");
    setError(null);
  }

  function closeDialog() {
    setDialog(null);
    setTargetState("");
    setReason("");
    setError(null);
  }

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    try {
      if (dialog === "redispatch") {
        await apiPost("/admin/api/redispatch", { ticketId });
      } else if (dialog === "set-state") {
        await apiPost("/admin/api/set-state", { ticketId, invoker, reason, targetState });
      } else if (dialog === "recapture-ac") {
        await apiPost("/admin/api/recapture-ac", { ticketId, callerBodyId: invoker, invoker, reason });
      }
      closeDialog();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setError("Unauthorized: your session does not have permission to perform this action.");
      } else {
        setError(err instanceof Error ? err.message : "An unexpected error occurred.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ops-actions">
      <button type="button" onClick={() => openDialog("redispatch")}>Redispatch</button>
      {variant === "full" && (
        <>
          <button type="button" onClick={() => openDialog("set-state")}>Set State</button>
          <button
            type="button"
            onClick={() => openDialog("recapture-ac")}
          >
            Recapture AC
          </button>
          {/* AC5: deploy disabled — deploy-policy.yaml sets ci_auto_deploy:false for this repo */}
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Deploy is disabled: deploy-policy.yaml sets ci_auto_deploy:false for fancy-openclaw-linear-connector. Use the handoff-host deploy path."
          >
            Deploy
          </button>
        </>
      )}

      {dialog !== null && (
        <div role="dialog" aria-modal="true" aria-label={`Confirm ${dialog}`}>
          <p>Confirm: <strong>{dialog}</strong> on <code>{ticketId}</code></p>

          {(dialog === "set-state") && (
            <div>
              <label htmlFor="ops-target-state">Target State</label>
              <input
                id="ops-target-state"
                type="text"
                placeholder="state"
                value={targetState}
                onChange={(e) => setTargetState(e.target.value)}
              />
            </div>
          )}

          {(dialog === "set-state" || dialog === "recapture-ac") && (
            <div>
              <label htmlFor="ops-reason">Reason</label>
              <input
                id="ops-reason"
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          )}

          {error && <p role="alert">{error}</p>}

          <button type="button" onClick={handleConfirm} disabled={loading}>
            Confirm
          </button>
          <button type="button" onClick={closeDialog} disabled={loading}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
