/**
 * ChoreScore V4 — repository-backed activity history.
 *
 * The balances screen must not read every ledger row just to show the first
 * page of history. Each source repository is queried with its own cursor and
 * page limit, then the small page-sized results are merged in memory. Fetching
 * `limit + 1` from each source is enough to determine the global next page:
 * any entry beyond the global first `limit` is strictly older than the returned
 * cursor and will be fetched again by the next call.
 */

import {
  ActivityFilter,
  ActivityLogPage,
} from '../../domain/calculations/activityLog';
import {
  ContributionEntry,
  CrossLedgerSettlement,
  ExpenseEntry,
} from '../../domain/entities';
import {
  PaginatedQuery,
  PaginatedResult,
} from '../../infrastructure/repositories';
import { AllRepositories } from '../../infrastructure/repositories/RepositoryFactory';

export interface ActivityHistoryOptions {
  limit?: number;
  cursor?: string | null;
  filter?: ActivityFilter;
  after?: string;
}

type ActivitySource<T> = {
  getByHouseholdPaginated(
    householdId: string,
    query?: PaginatedQuery,
  ): Promise<PaginatedResult<T>>;
};

export interface ActivityHistoryRepositories {
  contributions: ActivitySource<ContributionEntry>;
  expenses: ActivitySource<ExpenseEntry>;
  settlements: ActivitySource<CrossLedgerSettlement>;
}

function compareActivity(
  left: { occurredAt: string; id: string },
  right: { occurredAt: string; id: string },
): number {
  const byDate = right.occurredAt.localeCompare(left.occurredAt);
  return byDate !== 0 ? byDate : right.id.localeCompare(left.id);
}

export async function loadActivityHistoryPage(
  repos: ActivityHistoryRepositories | AllRepositories,
  householdId: string,
  options: ActivityHistoryOptions = {},
): Promise<ActivityLogPage> {
  const limit = options.limit ?? 20;
  const filter = options.filter ?? 'all';
  const query: PaginatedQuery = {
    limit: limit + 1,
    cursor: options.cursor ?? null,
    after: options.after,
  };

  const requests: Promise<ActivityLogPage['entries']>[] = [];

  if (filter === 'all' || filter === 'contribution') {
    requests.push(
      repos.contributions.getByHouseholdPaginated(householdId, query).then((page) =>
        page.items.map((entry) => ({ type: 'contribution' as const, entry })),
      ),
    );
  }
  if (filter === 'all' || filter === 'expense') {
    requests.push(
      repos.expenses.getByHouseholdPaginated(householdId, query).then((page) =>
        page.items.map((entry) => ({ type: 'expense' as const, entry })),
      ),
    );
  }
  if (filter === 'all' || filter === 'settlement') {
    requests.push(
      repos.settlements.getByHouseholdPaginated(householdId, query).then((page) =>
        page.items.map((entry) => ({ type: 'cross-ledger-settlement' as const, entry })),
      ),
    );
  }

  const merged = (await Promise.all(requests)).flat();
  merged.sort((left, right) => compareActivity(left.entry, right.entry));
  const entries = merged.slice(0, limit);
  const hasMore = merged.length > limit;
  const last = entries.length > 0 ? entries[entries.length - 1] : null;

  return {
    entries,
    cursor:
      hasMore && last
        ? JSON.stringify({ o: last.entry.occurredAt, i: last.entry.id })
        : null,
    hasMore,
  };
}
