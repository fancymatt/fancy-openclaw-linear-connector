/**
 * AI-1838 — Webhook mutation extraction.
 *
 * Extracts structured state/label/delegate changes from normalized Linear
 * webhook events into MutationAuditInput records for the audit store.
 *
 * This is the "observation" side of the out-of-band detection: every
 * state/label/delegate change Linear tells us about via webhook gets recorded
 * with source='webhook'. The reconcile sweep then checks whether a matching
 * proxy-forwarded mutation exists.
 */

import type { LinearEvent, LinearIssueUpdatedEvent } from "./schema.js";
import type { MutationAuditInput, ChangeType } from "../store/mutation-audit-store.js";

/**
 * Extract mutation audit records from a normalized Linear webhook event.
 *
 * Only Issue-update events carry mutation signals (state/label/delegate changes).
 * Returns an empty array for non-applicable events.
 */
export function extractWebhookMutations(
  event: LinearEvent,
  webhookEventId?: string,
): MutationAuditInput[] {
  if (event.type !== "Issue" || event.action !== "update") return [];

  const issueEvent = event as LinearIssueUpdatedEvent;
  const data = issueEvent.data;
  const updatedFrom = issueEvent.updatedFrom;
  const ticket = data.identifier || data.id;
  const ticketUuid = data.id;
  const actorId = event.actor?.id;
  const recordedAt = event.createdAt || new Date().toISOString();

  const mutations: MutationAuditInput[] = [];

  // ── State change ──────────────────────────────────────────────────────
  // Linear puts the old stateId in updatedFrom.stateId; the new state is
  // in data.state.
  if (updatedFrom && "stateId" in updatedFrom) {
    const oldStateId = String(updatedFrom.stateId ?? "");
    const newStateId = data.state?.id ?? "";
    const newStateName = data.state?.name ?? "";
    mutations.push({
      source: "webhook",
      ticket,
      changeType: "state" as ChangeType,
      field: `state:${newStateName || newStateId}`,
      oldValue: oldStateId,
      newValue: newStateId,
      actorId,
      webhookEventId: webhookEventId ?? null,
      ticketUuid,
      recordedAt,
    });
  }

  // ── Delegate change ───────────────────────────────────────────────────
  // Linear puts the old delegateId in updatedFrom.delegateId.
  if (updatedFrom && "delegateId" in updatedFrom) {
    const oldDelegateId = String(updatedFrom.delegateId ?? "");
    const newDelegateId = data.delegate?.id ?? "";
    mutations.push({
      source: "webhook",
      ticket,
      changeType: "delegate" as ChangeType,
      field: "delegateId",
      oldValue: oldDelegateId || null,
      newValue: newDelegateId || null,
      actorId,
      webhookEventId: webhookEventId ?? null,
      ticketUuid,
      recordedAt,
    });
  }

  // ── Assignee change ───────────────────────────────────────────────────
  if (updatedFrom && "assigneeId" in updatedFrom) {
    const oldAssigneeId = String(updatedFrom.assigneeId ?? "");
    const newAssigneeId = data.assigneeId ?? data.assignee?.id ?? "";
    mutations.push({
      source: "webhook",
      ticket,
      changeType: "assignee" as ChangeType,
      field: "assigneeId",
      oldValue: oldAssigneeId || null,
      newValue: newAssigneeId || null,
      actorId,
      webhookEventId: webhookEventId ?? null,
      ticketUuid,
      recordedAt,
    });
  }

  // ── Label changes ─────────────────────────────────────────────────────
  // Linear includes updatedFrom.labelIds (old array) when labels change.
  // We diff old vs new to record each add/remove.
  if (updatedFrom && "labelIds" in updatedFrom) {
    const oldLabelIds = Array.isArray(updatedFrom.labelIds)
      ? (updatedFrom.labelIds as unknown[]).map(String)
      : [];
    const newLabelIds = data.labelIds ?? [];
    const oldSet = new Set(oldLabelIds);
    const newSet = new Set(newLabelIds);

    for (const added of newLabelIds) {
      if (!oldSet.has(added)) {
        mutations.push({
          source: "webhook",
          ticket,
          changeType: "label" as ChangeType,
          field: `label:${added}`,
          oldValue: null,
          newValue: "added",
          actorId,
          webhookEventId: webhookEventId ?? null,
      ticketUuid,
          recordedAt,
        });
      }
    }
    for (const removed of oldLabelIds) {
      if (!newSet.has(removed)) {
        mutations.push({
          source: "webhook",
          ticket,
          changeType: "label" as ChangeType,
          field: `label:${removed}`,
          oldValue: "removed",
          newValue: null,
          actorId,
          webhookEventId: webhookEventId ?? null,
      ticketUuid,
          recordedAt,
        });
      }
    }
  }

  return mutations;
}
