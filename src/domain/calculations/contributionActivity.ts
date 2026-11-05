import { ContributionEntry, ContributionUnit } from '../entities';
import { Period, periodBoundary } from './periods';

export interface ContributionActivityQuery {
  unit: ContributionUnit;
  period: Period;
  persistentTaskId?: string | null;
  referenceDate?: Date;
}
export interface ContributionActivityTotal { memberId: string; value: number; count: number; }

export function activityBoundary(query: ContributionActivityQuery): string | undefined {
  return query.period === 'all-time' ? undefined : periodBoundary(query.period, query.referenceDate);
}

/** Oracle and in-memory fallback. SQLite reads derived aggregates instead. */
export function calculateContributionActivity(entries: ContributionEntry[], query: ContributionActivityQuery): ContributionActivityTotal[] {
  const after = activityBoundary(query);
  const totals = new Map<string, ContributionActivityTotal>();
  for (const entry of entries) {
    if (entry.unit !== query.unit || (after && entry.occurredAt < after)
      || (query.persistentTaskId !== undefined && (entry.persistentTaskId ?? null) !== query.persistentTaskId)) continue;
    const row = totals.get(entry.performedByMemberId) ?? { memberId: entry.performedByMemberId, value: 0, count: 0 };
    row.value += entry.value; row.count += 1;
    totals.set(row.memberId, row);
  }
  return [...totals.values()].sort((a,b) => a.memberId.localeCompare(b.memberId));
}
