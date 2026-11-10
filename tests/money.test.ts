import { parsePositiveNumber } from '../src/domain/services/addEntryService';
import { parseAmountToMinor, parseShareToMinor } from '../src/domain/services/addEntryService';
import { allocateExpense, calculateFinancialBalances } from '../src/domain/calculations/expenseLedger';
import { ExpenseEntry } from '../src/domain/entities';

test.each([['0.29',29],['1,01',101],['12',1200],['1 234,56',123456],['1\u202f234,56',123456],['90071992547409.91',Number.MAX_SAFE_INTEGER]])('exact minor units: %s', (raw, minor) => {
  expect(parseAmountToMinor(raw)).toBe(minor);
});
test.each(['1.005','-1','12 CHF','abc1','1e3','1,2,3','NaN','Infinity','90071992547409.92','123 45,00'])('reject ambiguous or unsafe money: %s', raw => {
  expect(parseAmountToMinor(raw)).toBeNull();
});
test('shares accept zero but never round sub-cent input', () => {
  expect(parseShareToMinor('')).toBe(0);
  expect(parseShareToMinor('0,00')).toBe(0);
  expect(parseShareToMinor('0.005')).toBeNull();
});
const entry: ExpenseEntry = { id: 'expense', householdId: 'group', title: 'Test', amountMinor: 101, currency: 'EUR',
  paidByMemberId: 'a', participantMemberIds: ['a','b','c'], splitMode: 'equal', occurredAt: '2026-01-01T00:00:00Z', createdBy: 'owner' };
test('equal split distributes every cent deterministically and remains exactly zero sum', () => {
  expect(allocateExpense(entry).map(s => s.amountMinor)).toEqual([34,34,33]);
  const values = [...calculateFinancialBalances([entry], 'EUR').values()];
  expect(values.reduce((a,b) => a+b,0)).toBe(0);
});
test('unsafe amounts and aggregate overflow fail explicitly rather than corrupting balances', () => {
  expect(() => allocateExpense({ ...entry, amountMinor: Number.MAX_SAFE_INTEGER+1 })).toThrow();
  const huge = { ...entry, participantMemberIds: ['b'], amountMinor: Number.MAX_SAFE_INTEGER };
  expect(() => calculateFinancialBalances([huge, huge], 'EUR')).toThrow('precision');
});


test.each(['abc1', '1e3', '1,2,3', '-1', '1.2 pts', 'Infinity', '12 34'])('task values and compensation rates reject malformed input: %s', raw => {
  expect(parsePositiveNumber(raw)).toBeNull();
});
test.each([['1,5', 1.5], ['1.5', 1.5], ['1 234,5', 1234.5]] as const)('task values and rates accept locale decimal %s', (raw, expected) => {
  expect(parsePositiveNumber(raw)).toBe(expected);
});
