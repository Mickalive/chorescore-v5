/**
 * ChoreScore V2 — Balance Calculations
 *
 * Pure functions for computing balances, compensations, and scores.
 * No side effects, no external dependencies.
 *
 * Core formula:
 * - For a CompletedEntry of duration D, performed by P for N beneficiaries:
 *   - P receives credit: +D
 *   - Each beneficiary receives: -D/N
 *   - If P is also a beneficiary, their own share cancels out naturally.
 *
 * The sum of all balances in a household is always zero.
 */

import { CompletedEntry, Balance, Compensation, FilterType, ScoreResult } from '../entities';

/**
 * Calculate raw (unweighted) balances from completed entries.
 * Returns a map of memberId -> balance in minutes.
 */
export function calculateBalances(entries: CompletedEntry[]): Map<string, number> {
  const balances = new Map<string, number>();

  for (const entry of entries) {
    const performer = entry.performedByMemberId;
    const beneficiaries = entry.beneficiaryMemberIds;
    const duration = entry.durationMinutes;

    if (beneficiaries.length === 0) continue;

    // Performer gets full credit
    balances.set(performer, (balances.get(performer) || 0) + duration);

    // Each beneficiary gets their share deducted
    const sharePerBeneficiary = duration / beneficiaries.length;
    for (const b of beneficiaries) {
      balances.set(b, (balances.get(b) || 0) - sharePerBeneficiary);
    }
  }

  return balances;
}

/**
 * Calculate weighted balances using entry weights.
 * Weight affects only the displayed balance, never the actual time.
 */
export function calculateWeightedBalances(entries: CompletedEntry[]): Map<string, number> {
  const balances = new Map<string, number>();

  for (const entry of entries) {
    const performer = entry.performedByMemberId;
    const beneficiaries = entry.beneficiaryMemberIds;
    const weightedDuration = entry.durationMinutes * entry.weight;

    if (beneficiaries.length === 0) continue;

    balances.set(performer, (balances.get(performer) || 0) + weightedDuration);

    const sharePerBeneficiary = weightedDuration / beneficiaries.length;
    for (const b of beneficiaries) {
      balances.set(b, (balances.get(b) || 0) - sharePerBeneficiary);
    }
  }

  return balances;
}

/**
 * Calculate performed minutes per member (total time each person spent).
 */
export function calculatePerformedMinutes(entries: CompletedEntry[]): Record<string, number> {
  const performed: Record<string, number> = {};

  for (const entry of entries) {
    performed[entry.performedByMemberId] =
      (performed[entry.performedByMemberId] || 0) + entry.durationMinutes;
  }

  return performed;
}

/**
 * Calculate performed weighted minutes per member.
 */
export function calculatePerformedWeightedMinutes(entries: CompletedEntry[]): Record<string, number> {
  const performed: Record<string, number> = {};

  for (const entry of entries) {
    performed[entry.performedByMemberId] =
      (performed[entry.performedByMemberId] || 0) + entry.durationMinutes * entry.weight;
  }

  return performed;
}

/**
 * Convert a balance map to sorted Balance array.
 */
export function balancesToArray(balances: Map<string, number>): Balance[] {
  return Array.from(balances.entries())
    .map(([memberId, minutes]) => ({ memberId, minutes }))
    .sort((a, b) => b.minutes - a.minutes);
}

/**
 * Calculate compensations (who owes whom).
 * Simple greedy algorithm: positives match negatives.
 */
export function calculateCompensations(balances: Balance[]): Compensation[] {
  const compensations: Compensation[] = [];
  const sorted = [...balances].sort((a, b) => b.minutes - a.minutes);

  let i = 0;
  let j = sorted.length - 1;

  while (i < j) {
    const positive = sorted[i];
    const negative = sorted[j];

    if (positive.minutes <= 0 || negative.minutes >= 0) break;

    const amount = Math.min(positive.minutes, -negative.minutes);
    if (amount > 0) {
      compensations.push({
        fromMemberId: negative.memberId,
        toMemberId: positive.memberId,
        minutes: amount,
      });
    }

    sorted[i] = { ...positive, minutes: positive.minutes - amount };
    sorted[j] = { ...negative, minutes: negative.minutes + amount };

    if (sorted[i].minutes === 0) i++;
    if (sorted[j].minutes === 0) j--;
  }

  return compensations;
}

/**
 * Sum all balances (should be zero for valid data).
 */
export function sumBalances(balances: Balance[]): number {
  return balances.reduce((sum, b) => sum + b.minutes, 0);
}

/**
 * Filter entries based on filter type.
 */
export function filterEntries(
  entries: CompletedEntry[],
  filter: FilterType,
  persistentTaskId?: string
): CompletedEntry[] {
  switch (filter) {
    case 'all':
      return entries;
    case 'persistent-task':
      return entries.filter(e => e.persistentTaskId === persistentTaskId);
    case 'others':
      return entries.filter(e => e.persistentTaskId === null);
    default:
      return entries;
  }
}

/**
 * Calculate full score for a given period and filter.
 */
export function calculateScore(
  entries: CompletedEntry[],
  period: 'week' | 'month' | 'year' | 'all-time',
  filter: FilterType,
  filterTaskId?: string,
  weightingEnabled: boolean = false
): ScoreResult {
  const filteredEntries = filterEntries(entries, filter, filterTaskId);
  const balancesMap = calculateBalances(filteredEntries);
  const balances = balancesToArray(balancesMap);
  const compensations = calculateCompensations(balances);
  const performedMinutes = calculatePerformedMinutes(filteredEntries);
  const sumOfBalances = sumBalances(balances);

  let weightedBalances: Balance[] | undefined;
  let weightedCompensations: Compensation[] | undefined;
  let performedWeightedMinutes: Record<string, number> | undefined;

  if (weightingEnabled) {
    const weightedBalancesMap = calculateWeightedBalances(filteredEntries);
    weightedBalances = balancesToArray(weightedBalancesMap);
    weightedCompensations = calculateCompensations(weightedBalances);
    performedWeightedMinutes = calculatePerformedWeightedMinutes(filteredEntries);
  }

  return {
    period,
    filter,
    filterTaskId,
    balances,
    compensations,
    performedMinutes,
    weightedBalances,
    weightedCompensations,
    performedWeightedMinutes,
    sumOfBalances,
  };
}
