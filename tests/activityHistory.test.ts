import { loadActivityHistoryPage } from '../src/application/use-cases/activityHistory';
import {
  ContributionEntry,
  CrossLedgerSettlement,
  ExpenseEntry,
} from '../src/domain/entities';

type Dated = { id: string; occurredAt: string };

function fakeSource<T extends Dated>(items: T[]) {
  const getByHouseholdPaginated = jest.fn(async (_householdId: string, query: any = {}) => {
    const limit = query.limit ?? 20;
    const cursor = query.cursor ? (JSON.parse(query.cursor) as { o: string; i: string }) : null;
    const filtered = items.filter((item) =>
      !cursor ||
      item.occurredAt < cursor.o ||
      (item.occurredAt === cursor.o && item.id < cursor.i));
    const page = filtered.slice(0, limit);
    const last = page.length > 0 ? page[page.length - 1] : null;
    return {
      items: page,
      cursor: filtered.length > limit && last ? JSON.stringify({ o: last.occurredAt, i: last.id }) : null,
      hasMore: filtered.length > limit,
    };
  });
  return { items, getByHouseholdPaginated };
}

function contribution(id: string, occurredAt: string): ContributionEntry {
  return {
    id, householdId: 'h', label: id, performedByMemberId: 'm1',
    beneficiaryMemberIds: ['m1'], value: 1, unit: 'minutes',
    persistentTaskId: null, occurredAt, createdBy: 'u',
  };
}

function expense(id: string, occurredAt: string): ExpenseEntry {
  return {
    id, householdId: 'h', title: id, amountMinor: 100, currency: 'EUR',
    paidByMemberId: 'm1', participantMemberIds: ['m1'], splitMode: 'equal',
    occurredAt, createdBy: 'u',
  };
}

function settlement(id: string, occurredAt: string): CrossLedgerSettlement {
  return {
    id, householdId: 'h', contributionCreditorMemberId: 'm1',
    counterpartyMemberId: 'm1', contributionValue: 1, contributionUnit: 'minutes',
    moneyAmountMinor: 100, currency: 'EUR',
    rateSnapshot: { contributionValue: 1, contributionUnit: 'minutes', moneyAmountMinor: 100, currency: 'EUR' },
    occurredAt, createdBy: 'u',
  };
}

describe('repository-backed activity history', () => {
  it('merges pages from every repository without reading whole collections', async () => {
    const contributions = fakeSource([
      contribution('c1', '2026-01-01T03:00:00.000Z'),
      contribution('c2', '2026-01-01T01:00:00.000Z'),
    ]);
    const expenses = fakeSource([
      expense('e1', '2026-01-01T02:30:00.000Z'),
      expense('e2', '2026-01-01T00:30:00.000Z'),
    ]);
    const settlements = fakeSource([
      settlement('s1', '2026-01-01T02:45:00.000Z'),
    ]);
    const repos = {
      contributions: { ...contributions, getByHousehold: () => { throw new Error('full read'); } },
      expenses, settlements,
    };

    const first = await loadActivityHistoryPage(repos as any, 'h', { limit: 2 });
    expect(first.entries.map((entry) => entry.entry.id)).toEqual(['c1', 's1']);
    expect(first.hasMore).toBe(true);
    expect(contributions.getByHouseholdPaginated).toHaveBeenCalledWith(
      'h', expect.objectContaining({ limit: 3, cursor: null }),
    );

    const second = await loadActivityHistoryPage(repos as any, 'h', {
      limit: 2, cursor: first.cursor,
    });
    expect(second.entries.map((entry) => entry.entry.id)).toEqual(['e1', 'c2']);
    expect(second.hasMore).toBe(true);

    const third = await loadActivityHistoryPage(repos as any, 'h', {
      limit: 2, cursor: second.cursor,
    });
    expect(third.entries.map((entry) => entry.entry.id)).toEqual(['e2']);
    expect(third.hasMore).toBe(false);
    expect(third.cursor).toBeNull();
  });

  it('queries only the selected filter source', async () => {
    const contributions = fakeSource([contribution('c1', '2026-01-01T03:00:00.000Z')]);
    const expenses = fakeSource([expense('e1', '2026-01-01T02:00:00.000Z')]);
    const settlements = fakeSource([settlement('s1', '2026-01-01T01:00:00.000Z')]);

    const page = await loadActivityHistoryPage(
      { contributions, expenses, settlements } as any,
      'h',
      { filter: 'settlement', limit: 20 },
    );

    expect(page.entries.map((entry) => entry.entry.id)).toEqual(['s1']);
    expect(contributions.getByHouseholdPaginated).not.toHaveBeenCalled();
    expect(expenses.getByHouseholdPaginated).not.toHaveBeenCalled();
    expect(settlements.getByHouseholdPaginated).toHaveBeenCalledTimes(1);
  });
});
