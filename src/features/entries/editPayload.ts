import { ContributionEntry, ExpenseEntry } from '../../domain/entities';

/**
 * Build the update payload for an edited task.
 *
 * The explicit `undefined` entries are deliberate: the repository merges the
 * partial over the existing row, and SQLite writes `NULL` for undefined, so an
 * edit can genuinely *remove* a note, a photo, a category or a custom split.
 * Spreading the draft alone would keep stale values when a field is omitted.
 */
export function taskUpdatePayload(
  draft: Omit<ContributionEntry, 'id'>,
  modifiedBy: string,
): Partial<ContributionEntry> {
  return {
    label: draft.label,
    performedByMemberId: draft.performedByMemberId,
    beneficiaryMemberIds: draft.beneficiaryMemberIds,
    value: draft.value,
    unit: draft.unit,
    persistentTaskId: draft.persistentTaskId,
    occurredAt: draft.occurredAt,
    categoryId: draft.categoryId,
    categoryLabelSnapshot: draft.categoryLabelSnapshot,
    note: draft.note,
    attachments: draft.attachments,
    splitMode: draft.splitMode,
    splitWeights: draft.splitWeights,
    splitSource: draft.splitSource,
    modifiedBy,
  };
}

/** Same "edit can clear a field" contract as {@link taskUpdatePayload}. */
export function expenseUpdatePayload(
  draft: Omit<ExpenseEntry, 'id'>,
  modifiedBy: string,
): Partial<ExpenseEntry> {
  return {
    title: draft.title,
    amountMinor: draft.amountMinor,
    currency: draft.currency,
    paidByMemberId: draft.paidByMemberId,
    participantMemberIds: draft.participantMemberIds,
    splitMode: draft.splitMode,
    customShares: draft.customShares,
    category: draft.category,
    categoryId: draft.categoryId,
    categoryLabelSnapshot: draft.categoryLabelSnapshot,
    note: draft.note,
    attachments: draft.attachments,
    occurredAt: draft.occurredAt,
    modifiedBy,
  };
}

