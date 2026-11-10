import { ContributionEntry, CrossLedgerSettlement, ExpenseEntry } from '../entities';
import { calculateFinancialBalances } from './expenseLedger';
import { normalizeCurrency } from './validation';
import { validateCrossLedgerSettlement } from './crossLedgerSettlement';
import { deltaUpdateContribution, deltaUpdateContributionFromSettlement, deltaUpdateMoneyFromSettlement } from './materializedBalances';

/** Local derived data, never an authoritative ledger or a synced collection. */
export interface BalanceImpact {
  ledger: 'contribution' | 'money';
  bucket: string;
  memberId: string;
  amount: number;
}

function rows(ledger: BalanceImpact['ledger'], bucket: string, values: Map<string, number>): BalanceImpact[] {
  // Keep zero impacts: a fully self-paid expense still establishes its currency.
  return [...values].map(([memberId, amount]) => ({ ledger, bucket, memberId, amount }));
}

export function contributionBalanceImpact(entry: ContributionEntry): BalanceImpact[] {
  return rows('contribution', entry.unit, deltaUpdateContribution(new Map(), entry, entry.unit, [], 'add'));
}

export function expenseBalanceImpact(entry: ExpenseEntry): BalanceImpact[] {
  return rows('money', normalizeCurrency(entry.currency), calculateFinancialBalances([entry], entry.currency));
}

export function settlementBalanceImpact(entry: CrossLedgerSettlement): BalanceImpact[] {
  validateCrossLedgerSettlement(entry);
  return [
    ...rows('contribution', entry.contributionUnit, deltaUpdateContributionFromSettlement(new Map(), entry, entry.contributionUnit, 'add')),
    ...rows('money', normalizeCurrency(entry.currency), deltaUpdateMoneyFromSettlement(new Map(), entry, 'add')),
  ];
}
