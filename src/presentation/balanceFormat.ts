/**
 * Locale-aware balance text.
 *
 * The ledger stores exact integers (minor units) and plain numbers. Formatting
 * is a presentation concern: French must render "4,5 pts" / "0,50 CHF", while
 * English renders "4.5 pts" / "CHF 0.50". Keeping this pure makes the FR/EN
 * contract testable without rendering the whole Balances screen.
 */

import { ContributionTransfer, MoneyTransfer } from '../domain/entities';

export function formatQuantity(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

export function formatContributionValue(
  value: number,
  unitShort: string,
  locale: string,
): string {
  const formatted = formatQuantity(Math.abs(value), locale);
  if (value > 0) return `+ ${formatted} ${unitShort}`;
  if (value < 0) return `- ${formatted} ${unitShort}`;
  return `${formatQuantity(0, locale)} ${unitShort}`;
}

function currencyFormatter(currency: string, locale: string): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatCurrencyAmount(
  amountMinor: number,
  currency: string,
  locale: string,
): string {
  return currencyFormatter(currency, locale).format(amountMinor / 100);
}

export function formatMoneyAmount(
  amountMinor: number,
  currency: string,
  locale: string,
): string {
  const formatted = currencyFormatter(currency, locale).format(Math.abs(amountMinor) / 100);
  if (amountMinor > 0) return `+ ${formatted}`;
  if (amountMinor < 0) return `- ${formatted}`;
  return formatted;
}

export function formatTransferContribution(
  transfer: ContributionTransfer,
  memberName: (id: string) => string,
  unitShort: string,
  locale: string,
): string {
  return `${memberName(transfer.fromMemberId)} → ${memberName(transfer.toMemberId)} : ${formatQuantity(transfer.value, locale)} ${unitShort}`;
}

export function formatTransferMoney(
  transfer: MoneyTransfer,
  memberName: (id: string) => string,
  locale: string,
): string {
  return `${memberName(transfer.fromMemberId)} → ${memberName(transfer.toMemberId)} : ${formatCurrencyAmount(Math.abs(transfer.amountMinor), transfer.currency, locale)}`;
}
