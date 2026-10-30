import {
  formatContributionValue,
  formatMoneyAmount,
  formatTransferContribution,
  formatTransferMoney,
} from '../src/presentation/balanceFormat';

const plain = (value: string) => value.replace(/[\u00a0\u202f]/g, ' ');
const name = (id: string) => ({ a: 'Alice', b: 'Bob' }[id] ?? id);

test('contribution values use locale decimals and never float artifacts', () => {
  expect(formatContributionValue(4.5, 'pts', 'fr-FR')).toBe('+ 4,5 pts');
  expect(formatContributionValue(-2.25, 'min', 'fr-FR')).toBe('- 2,25 min');
  expect(formatContributionValue(4.5, 'pts', 'en-US')).toBe('+ 4.5 pts');
  expect(formatContributionValue(0, 'pts', 'fr-FR')).toBe('0 pts');
});

test('money renders as locale currency with the code, not a hard-coded English layout', () => {
  expect(plain(formatMoneyAmount(50, 'CHF', 'fr-FR'))).toBe('+ 0,50 CHF');
  expect(plain(formatMoneyAmount(-1250, 'CHF', 'fr-FR'))).toBe('- 12,50 CHF');
  expect(plain(formatMoneyAmount(50, 'EUR', 'en-US'))).toBe('+ EUR 0.50');
  expect(plain(formatMoneyAmount(0, 'CHF', 'fr-FR'))).toBe('0,00 CHF');
});

test('transfer suggestions share the same locale formatting as balances', () => {
  expect(
    formatTransferContribution(
      { fromMemberId: 'b', toMemberId: 'a', value: 4.5, unit: 'points' },
      name,
      'pts',
      'fr-FR',
    ),
  ).toBe('Bob → Alice : 4,5 pts');
  expect(
    plain(
      formatTransferMoney(
        { fromMemberId: 'b', toMemberId: 'a', amountMinor: 50, currency: 'CHF' },
        name,
        'fr-FR',
      ),
    ),
  ).toBe('Bob → Alice : 0,50 CHF');
});
