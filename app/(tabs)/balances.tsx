/**
 * ChoreScore V3 — Balances Tab
 *
 * Dual ledger view: Contribution + Argent.
 * Shows who is ahead or behind on each dimension.
 * Period filters (week, month, year, all-time) as VIEWS, never resets.
 *
 * Settlement suggestions are greedy pairwise transfers.
 * Cross-ledger compensation is disabled by default and requires a
 * group-defined rate. Each settlement produces an immutable
 * CrossLedgerSettlement record with a snapshotted rate.
 *
 * Balances are derived views — they never mutate the underlying ledger.
 * Stored member totals refresh on data change; history remains paginated.
 *
 * Periods narrow paginated history, never the main perpetual balances or
 * compensation suggestions. Settlements remain in both all-time ledgers.
 */

import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Alert,
  TextInput,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ScreenContainer } from '../../src/ui/components/ScreenContainer';
import { Text } from '../../src/ui/components/Text';
import { Card } from '../../src/ui/components/Card';
import { Button } from '../../src/ui/components/Button';
import { colors, spacing, borderRadius } from '../../src/ui/design-system/theme';
import { useApp, DataChangeType } from '../../src/features/app/AppContext';
import { useI18n } from '../../src/i18n';
import { parsePositiveNumber } from '../../src/domain/services/addEntryService';
import {
  Household,
  Member,
  MoneyTransfer,
  ActivityEntry,
} from '../../src/domain/entities';
import {
  balancesToArray,
  suggestContributionTransfers,
  contributionLedgerIsZeroSum,
} from '../../src/domain/calculations/contributionLedger';
import {
  financialBalancesToArray,
  suggestMoneyTransfers,
  financialLedgerIsZeroSum,
} from '../../src/domain/calculations/expenseLedger';
import { periodBoundary, Period } from '../../src/domain/calculations/periods';
import { quoteCrossLedgerMoneyAmount } from '../../src/domain/calculations/crossLedgerSettlement';
import { loadGroupBalances, createProjectedSettlement } from '../../src/application/use-cases/groupBalances';
import { LoadingState, ErrorState } from '../../src/ui/components/States';
import type { BalanceSnapshot } from '../../src/domain/calculations/materializedBalances';
import {
  ActivityFilter,
  ActivityLogPage,
} from '../../src/domain/calculations/activityLog';
import { loadActivityHistoryPage } from '../../src/application/use-cases/activityHistory';
import {
  formatContributionValue,
  formatCurrencyAmount,
  formatMoneyAmount,
  formatQuantity,
  formatTransferContribution,
  formatTransferMoney,
} from '../../src/presentation/balanceFormat';

// ── Helpers ────────────────────────────────────────────────────

function formatActivityRow(
  entry: ActivityEntry,
  memberName: (id: string) => string,
  unitShort: string,
  settlementLabel: string,
  locale: string,
): string {
  switch (entry.type) {
    case 'contribution': {
      const e = entry.entry;
      const val = formatContributionValue(e.value, unitShort, locale);
      return `${e.label}  ${val}  ${memberName(e.performedByMemberId)} → ${e.beneficiaryMemberIds.map(memberName).join(', ')}`;
    }
    case 'expense': {
      const e = entry.entry;
      return `${e.title}  ${formatMoneyAmount(e.amountMinor, e.currency, locale)}  ${memberName(e.paidByMemberId)} → ${e.participantMemberIds.map(memberName).join(', ')}`;
    }
    case 'cross-ledger-settlement': {
      const e = entry.entry;
      const contrib = formatContributionValue(-e.contributionValue, unitShort, locale);
      const money = formatMoneyAmount(e.moneyAmountMinor, e.currency, locale);
      return `${settlementLabel}  ${memberName(e.contributionCreditorMemberId)} ${contrib} ↔ ${money}`;
    }
  }
}

const HISTORY_PAGE_SIZE = 20;

// ── Component ──────────────────────────────────────────────────

export default function BalancesScreen() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { currentHouseholdId, currentUser, repos, services, subscribeToDataChanges, emitDataChange } = useApp();
  const [period, setPeriod] = useState<Period>('all-time');
  const [household, setHousehold] = useState<Household | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [snapshot, setSnapshot] = useState<BalanceSnapshot>(() => ({ contribution: new Map(), moneyByCurrency: new Map() }));
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [balanceError, setBalanceError] = useState(false);
  const loadRequestRef = useRef(0);
  const activeGroupRef = useRef(currentHouseholdId);
  const lastHouseholdIdRef = useRef<string | null>(null);

  // Compenser modal state
  const [showCompenser, setShowCompenser] = useState(false);
  const [compenserCreditor, setCompenserCreditor] = useState<string>('');
  const [compenserValue, setCompenserValue] = useState<string>('');
  const [compenserError, setCompenserError] = useState<string | null>(null);
  const compensatingRef = useRef(false);
  const [isCompensating, setIsCompensating] = useState(false);

  // History filter state
  const [historyFilter, setHistoryFilter] = useState<ActivityFilter>('all');
  const [historyPage, setHistoryPage] = useState<ActivityLogPage | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const historyRequestRef = useRef(0);
  useLayoutEffect(() => {
    historyRequestRef.current += 1;
    setHistoryPage(null);
    setHistoryError(false);
    return () => { historyRequestRef.current += 1; };
  }, [currentHouseholdId, historyFilter, period]);

  // Entry action sheet (Edit / Delete / Share) — historical entries are
  // modified or removed here under Balances, never in the past-only ledger.
  const [selectedEntry, setSelectedEntry] = useState<ActivityEntry | null>(null);

  // Read a durable projection, never complete ledger payloads. Group changes
  // invalidate in-flight reads and close actions before the next frame.
  useLayoutEffect(() => {
    activeGroupRef.current = currentHouseholdId;
    loadRequestRef.current += 1;
    setBalanceLoading(true);
    setBalanceError(false);
    setSelectedEntry(null);
    setShowCompenser(false);
  }, [currentHouseholdId]);

  const fullLoad = useCallback(async () => {
    const id = currentHouseholdId;
    if (!id || activeGroupRef.current !== id) return;
    const request = ++loadRequestRef.current;
    if (lastHouseholdIdRef.current !== id) setBalanceLoading(true);
    setBalanceError(false);
    try {
      const loaded = await loadGroupBalances(repos, id);
      if (request !== loadRequestRef.current || activeGroupRef.current !== id) return;
      setHousehold(loaded.household);
      setMembers(loaded.members);
      setSnapshot(loaded.snapshot);
      lastHouseholdIdRef.current = id;
      setBalanceLoading(false);
    } catch {
      if (request === loadRequestRef.current && activeGroupRef.current === id) {
        setBalanceError(true);
        setBalanceLoading(false);
      }
    }
  }, [currentHouseholdId, repos]);

  const handleDataChange = useCallback(async (type: DataChangeType, id: string) => {
    if (id === currentHouseholdId && ['contribution','expense','settlement','member','household'].includes(type)) await fullLoad();
  }, [currentHouseholdId, fullLoad]);

  useEffect(() => subscribeToDataChanges(handleDataChange), [subscribeToDataChanges, handleDataChange]);
  useEffect(() => {
    void fullLoad();
    return () => { loadRequestRef.current += 1; };
  }, [fullLoad]);
  useFocusEffect(useCallback(() => {
    if (lastHouseholdIdRef.current === currentHouseholdId) void fullLoad();
  }, [currentHouseholdId, fullLoad]));

  // ── Member name helper ────────────────────────────────────

  const memberName = useCallback(
    (memberId: string) => members.find((m) => m.id === memberId)?.name || t('state.unknownMember'),
    [members, t]
  );

  // ── Period-filtered balances ───────────────────────────────

  const unit = household?.contributionUnit ?? 'minutes';
  const memberIds = useMemo(() => members.map((m) => m.id), [members]);

  // Main balances are perpetual. Period selection narrows history only; it
  // must never hide an old debt or change compensation suggestions.
  const contributionBalances = snapshot.contribution;

  const contributionArray = useMemo(
    () => balancesToArray(contributionBalances),
    [contributionBalances]
  );

  const moneyBalancesByCurrency = snapshot.moneyByCurrency;

  // Settlement suggestions
  const contributionSuggestions = useMemo(
    () => suggestContributionTransfers(contributionBalances, unit),
    [contributionBalances, unit]
  );

  const moneySuggestions = useMemo(() => {
    const suggestions: MoneyTransfer[] = [];
    for (const [currency, balances] of moneyBalancesByCurrency) {
      suggestions.push(...suggestMoneyTransfers(balances, currency));
    }
    return suggestions;
  }, [moneyBalancesByCurrency]);

  // Zero-sum checks
  const isContributionZeroSum = useMemo(
    () => contributionLedgerIsZeroSum(contributionBalances),
    [contributionBalances]
  );

  // ── Compenser action logic ─────────────────────────────────

  const canCompensate = household?.crossLedgerCompensationEnabled === true
    && household.contributionToMoneyRate !== null;

  // Build Avant/Apres preview for the Compenser modal
  const compenserPreview = useMemo(() => {
    if (!canCompensate || !compenserCreditor || !compenserValue) return null;
    const value = parsePositiveNumber(compenserValue);
    if (value === null) return null;
    const rate = household!.contributionToMoneyRate!;

    // Find a counterparty with positive money balance (creditor in money ledger)
    let counterpartyId: string | null = null;
    for (const [currency, balances] of moneyBalancesByCurrency) {
      if (currency !== rate.currency) continue;
      for (const [memberId, amount] of balances) {
        if (memberId !== compenserCreditor && amount > 0) {
          counterpartyId = memberId;
          break;
        }
      }
      if (counterpartyId) break;
    }
    if (!counterpartyId) return null;

    const moneyAmount = quoteCrossLedgerMoneyAmount(value, unit, rate);
    if (moneyAmount <= 0) return null;

    // Compute before/after for both ledgers
    const contribBefore = balancesToArray(contributionBalances);
    const contribAfter = contribBefore.map((b) => {
      if (b.memberId === compenserCreditor) return { ...b, value: b.value - value };
      if (b.memberId === counterpartyId) return { ...b, value: b.value + value };
      return b;
    });

    const currBalances = moneyBalancesByCurrency.get(rate.currency);
    const moneyBefore = currBalances ? financialBalancesToArray(currBalances, rate.currency) : [];
    const moneyAfter = moneyBefore.map((b) => {
      if (b.memberId === compenserCreditor) return { ...b, amountMinor: b.amountMinor + moneyAmount };
      if (b.memberId === counterpartyId) return { ...b, amountMinor: b.amountMinor - moneyAmount };
      return b;
    });

    return {
      counterpartyId,
      moneyAmount,
      rate,
      contribBefore,
      contribAfter,
      moneyBefore,
      moneyAfter,
    };
  }, [
    canCompensate, compenserCreditor, compenserValue, household,
    unit, contributionBalances, moneyBalancesByCurrency,
  ]);

  const handleCompenserConfirm = useCallback(async () => {
    if (!currentHouseholdId || !household || !compenserPreview || compensatingRef.current) return;
    setCompenserError(null);

    const value = parsePositiveNumber(compenserValue);
    if (value === null) return;
    const rate = compenserPreview.rate;
    const moneyAmount = compenserPreview.moneyAmount;

    // Create the settlement entity
    const settlementData = {
      householdId: currentHouseholdId,
      contributionCreditorMemberId: compenserCreditor,
      counterpartyMemberId: compenserPreview.counterpartyId,
      contributionValue: value,
      contributionUnit: unit,
      moneyAmountMinor: moneyAmount,
      currency: rate.currency,
      rateSnapshot: rate,
      occurredAt: new Date().toISOString(),
      // Audit identity of the member who performed the settlement. The
      // authority replaces this with the authenticated uid when syncing.
      createdBy: currentUser?.userId ?? household.ownerId,
    };

    compensatingRef.current = true;
    setIsCompensating(true);
    try {
      await createProjectedSettlement(repos, settlementData);
      await fullLoad();
      // Re-reading the projection is idempotent; notifying sync can no longer
      // apply this settlement twice to an in-memory balance snapshot.
      emitDataChange('settlement', currentHouseholdId);

      // Close modal and reset
      setShowCompenser(false);
      setCompenserCreditor('');
      setCompenserValue('');
    } catch {
      setCompenserError(t('state.error'));
    } finally {
      compensatingRef.current = false;
      setIsCompensating(false);
    }
  }, [
    currentHouseholdId, currentUser, household, compenserPreview, compenserCreditor, compenserValue,
    unit, repos, emitDataChange, fullLoad, t,
  ]);

  // ── History pagination ─────────────────────────────────────

  const loadHistoryPage = useCallback(async (filter: ActivityFilter, cursor?: string | null) => {
    if (!currentHouseholdId) return;
    const request = historyRequestRef.current + 1;
    historyRequestRef.current = request;
    setHistoryLoading(true);
    setHistoryError(false);
    try {
      const page = await loadActivityHistoryPage(repos, currentHouseholdId, {
        limit: HISTORY_PAGE_SIZE,
        filter,
        cursor: cursor ?? null,
        after: period === 'all-time' ? undefined : periodBoundary(period),
      });
      if (request === historyRequestRef.current && activeGroupRef.current === currentHouseholdId) setHistoryPage(page);
    } catch {
      if (request === historyRequestRef.current && activeGroupRef.current === currentHouseholdId) setHistoryError(true);
    } finally {
      if (request === historyRequestRef.current) setHistoryLoading(false);
    }
  }, [currentHouseholdId, repos, period]);

  // Reset history page on filter change and after every local ledger change.
  // The page itself comes from the repository, never from the full arrays.
  useEffect(() => {
    void loadHistoryPage(historyFilter);
  }, [historyFilter, loadHistoryPage, snapshot]);

  // ── Render ─────────────────────────────────────────────────

  const unitLabel = unit === 'minutes' ? t('unit.minutesShort') : t('unit.pointsShort');

  const periodLabels: Record<Period, string> = {
    week: t('balances.periodWeek'),
    month: t('balances.periodMonth'),
    year: t('balances.periodYear'),
    'all-time': t('balances.periodAll'),
  };

  const historyFilterLabels: Record<ActivityFilter, string> = {
    all: t('balances.filterAll'),
    contribution: t('balances.filterTasks'),
    expense: t('balances.filterExpenses'),
    settlement: t('balances.filterSettlements'),
  };

  // ── Historical entry actions ───────────────────────────────

  const closeEntryActions = () => setSelectedEntry(null);

  const handleEditEntry = (entry: ActivityEntry) => {
    if (entry.type === 'cross-ledger-settlement') return;
    const entryId = entry.entry.id;
    const entryType = entry.type === 'contribution' ? 'task' : 'expense';
    setSelectedEntry(null);
    router.push({ pathname: '/edit-entry', params: { entryId, entryType } });
  };

  const handleDeleteEntry = (entry: ActivityEntry) => {
    if (entry.type === 'cross-ledger-settlement' || !currentHouseholdId) return;
    const isTask = entry.type === 'contribution';
    const entryId = entry.entry.id;
    setSelectedEntry(null);
    Alert.alert(
      t('balances.deleteEntry'),
      isTask ? t('balances.deleteConfirmTask') : t('balances.deleteConfirmExpense'),
      [
        { text: t('action.cancel'), style: 'cancel' },
        {
          text: t('balances.deleteEntry'),
          style: 'destructive',
          onPress: async () => {
            try {
              if (isTask) {
                await repos.withTransaction(async () => repos.contributions.delete(entryId));
                emitDataChange('contribution', currentHouseholdId);
              } else {
                await repos.withTransaction(async () => repos.expenses.delete(entryId));
                emitDataChange('expense', currentHouseholdId);
              }
            } catch {
              Alert.alert(t('state.error'), t('add.errorDelete'));
            }
          },
        },
      ],
    );
  };

  const handleShareEntry = (entry: ActivityEntry) => {
    setSelectedEntry(null);
    const message = formatActivityRow(entry, memberName, unitLabel, t('add.settlement'), locale);
    services.share.share({ message });
  };

  if (balanceError) return (
    <ScreenContainer><ErrorState title={t('state.error')} message={t('state.genericError')}
      retryLabel={t('action.retry')} onRetry={() => { void fullLoad(); }} /></ScreenContainer>
  );
  if (balanceLoading || household?.id !== currentHouseholdId) return (
    <ScreenContainer><LoadingState message={t('state.loading')} /></ScreenContainer>
  );

  return (
    <ScreenContainer>
      <View style={styles.scrollContent}>
        <View style={styles.header}>
          <Text variant="screenTitle">{t('balances.title')}</Text>
        </View>

        {/* Period filter */}
        <View style={styles.periodSwitch}>
          {(['week', 'month', 'year', 'all-time'] as Period[]).map((p) => (
            <TouchableOpacity
              key={p}
              style={[styles.periodButton, period === p && styles.periodButtonActive]}
              onPress={() => { if (period !== p) setHistoryPage(null); setPeriod(p); }}
              testID={`balances.period.${p}`}
              accessibilityRole="button"
              accessibilityState={{ selected: period === p }}
            >
              <Text
                variant="caption"
                color={period === p ? colors.textOnPrimary : colors.textSecondary}
              >
                {periodLabels[p]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Task Ledger Block */}
        <Text variant="caption" color={colors.textSecondary}>{t('balances.historyPeriodHint')}</Text>
        <Text variant="sectionTitle" style={styles.sectionTitle}>
          {t('balances.tasks')}
        </Text>
        <Card style={styles.balanceCard}>
          {contributionArray.length === 0 ? (
            <Text variant="body" style={styles.emptyText}>
              {t('balances.emptyTasks')}
            </Text>
          ) : (
            contributionArray.map((balance) => (
              <View key={balance.memberId} style={styles.balanceRow}>
                <Text variant="body" style={styles.memberName}>
                  {memberName(balance.memberId)}
                </Text>
                <Text
                  variant="balance"
                  color={
                    balance.value > 0
                      ? colors.balancePositive
                      : balance.value < 0
                      ? colors.balanceNegative
                      : colors.textSecondary
                  }
                >
                  {formatContributionValue(balance.value, unitLabel, locale)}
                </Text>
              </View>
            ))
          )}
          {contributionArray.length > 0 && (
            <View style={styles.zeroSumBadge}>
              <Text variant="caption" color={isContributionZeroSum ? colors.balancePositive : colors.balanceNegative}>
                {isContributionZeroSum ? t('balances.zeroSum') : t('balances.incoherent')}
              </Text>
            </View>
          )}
        </Card>

        {/* Contribution Settlement Suggestions */}
        {contributionSuggestions.length > 0 && (
          <Card style={styles.suggestionCard}>
            <View style={styles.suggestionHeader}>
              <Text variant="caption" color={colors.textSecondary}>
                {t('balances.suggestedSettlements')}
              </Text>
            </View>
            {contributionSuggestions.map((transfer, i) => (
              <View key={i} style={styles.suggestionRow}>
                <Text variant="body" style={styles.suggestionText}>
                  {formatTransferContribution(transfer, memberName, unitLabel, locale)}
                </Text>
              </View>
            ))}
          </Card>
        )}

        {/* Money Ledger Block */}
        <Text variant="sectionTitle" style={styles.sectionTitle}>
          {t('balances.money')}
        </Text>
        {moneyBalancesByCurrency.size === 0 ? (
          <Card style={styles.balanceCard}>
            <Text variant="body" style={styles.emptyText}>
              {t('balances.emptyExpenses')}
            </Text>
          </Card>
        ) : (
          Array.from(moneyBalancesByCurrency.entries()).map(([currency, balances]) => {
            const arr = financialBalancesToArray(balances, currency);
            const isZeroSum = financialLedgerIsZeroSum(balances);
            return (
              <Card key={currency} style={styles.balanceCard}>
                {arr.map((balance) => (
                  <View key={balance.memberId} style={styles.balanceRow}>
                    <Text variant="body" style={styles.memberName}>
                      {memberName(balance.memberId)}
                    </Text>
                    <Text
                      variant="balance"
                      color={
                        balance.amountMinor > 0
                          ? colors.balancePositive
                          : balance.amountMinor < 0
                          ? colors.balanceNegative
                          : colors.textSecondary
                      }
                    >
                      {formatMoneyAmount(balance.amountMinor, currency, locale)}
                    </Text>
                  </View>
                ))}
                <View style={styles.zeroSumBadge}>
                  <Text variant="caption" color={isZeroSum ? colors.balancePositive : colors.balanceNegative}>
                    {isZeroSum ? t('balances.zeroSum') : t('balances.incoherent')} ({currency})
                  </Text>
                </View>
              </Card>
            );
          })
        )}

        {/* Money Settlement Suggestions */}
        {moneySuggestions.length > 0 && (
          <Card style={styles.suggestionCard}>
            <View style={styles.suggestionHeader}>
              <Text variant="caption" color={colors.textSecondary}>
                {t('balances.suggestedSettlements')}
              </Text>
            </View>
            {moneySuggestions.map((transfer, i) => (
              <View key={i} style={styles.suggestionRow}>
                <Text variant="body" style={styles.suggestionText}>
                  {formatTransferMoney(transfer, memberName, locale)}
                </Text>
              </View>
            ))}
          </Card>
        )}

        {/* Cross-ledger compensation info + Compenser action */}
        {household && (
          <Card style={styles.compensationCard}>
            <View style={styles.compensationHeader}>
              <Text variant="sectionTitle" style={{ fontSize: 16 }}>
                {t('balances.compensation')}
              </Text>
              <View style={[styles.statusBadge, household.crossLedgerCompensationEnabled ? styles.statusEnabled : styles.statusDisabled]}>
                <Text variant="caption" color={colors.textOnPrimary}>
                  {household.crossLedgerCompensationEnabled
                    ? t('balances.compensationEnabled')
                    : t('balances.compensationDisabled')}
                </Text>
              </View>
            </View>
            <Text variant="body" style={styles.compensationDescription}>
              {household.crossLedgerCompensationEnabled
                ? t('balances.compensationRate', {
                    value: household.contributionToMoneyRate
                      ? formatQuantity(household.contributionToMoneyRate.contributionValue, locale)
                      : '',
                    unit: unitLabel,
                    money: household.contributionToMoneyRate
                      ? formatCurrencyAmount(
                          household.contributionToMoneyRate.moneyAmountMinor,
                          household.contributionToMoneyRate.currency,
                          locale,
                        )
                      : '—',
                  })
                : t('balances.compensationDisabledHelp')}
            </Text>
            {household.crossLedgerCompensationEnabled && household.contributionToMoneyRate && (
              <Text variant="caption" color={colors.textSecondary} style={{ marginTop: spacing.sm }}>
                {t('balances.compensationImmutable')}
              </Text>
            )}
            {canCompensate && (
              <Button
                title={t('balances.compensate')}
                variant="secondary"
                size="small"
                style={{ marginTop: spacing.md }}
                onPress={() => setShowCompenser(true)}
                testID="balances.compensateButton"
              />
            )}
          </Card>
        )}

        {/* ── Filtered History Section ──────────────────────── */}
        <Text variant="sectionTitle" style={styles.sectionTitle}>
          {t('balances.activity')}
        </Text>
        <View style={styles.historyFilterRow}>
          {(['all', 'contribution', 'expense', 'settlement'] as ActivityFilter[]).map((f) => (
            <TouchableOpacity
              key={f}
              style={[styles.historyFilterBtn, historyFilter === f && styles.historyFilterBtnActive]}
              onPress={() => setHistoryFilter(f)}
            >
              <Text
                variant="caption"
                color={historyFilter === f ? colors.textOnPrimary : colors.textSecondary}
              >
                {historyFilterLabels[f]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Card style={styles.historyCard}>
          {historyError && <ErrorState title={t('state.errorTitle')} message={t('balances.historyError')}
            onRetry={() => { void loadHistoryPage(historyFilter); }} retryLabel={t('action.retry')} />}
          {historyPage && historyPage.entries.length > 0 ? (
            <>
              {historyPage.entries.map((entry, index) => (
                <TouchableOpacity
                  key={entry.entry.id}
                  testID={`balances.history.index.${index}`}
                  style={styles.historyRow}
                  onPress={() => setSelectedEntry(entry)}
                  accessibilityRole="button"
                  accessibilityLabel={formatActivityRow(
                    entry,
                    memberName,
                    unitLabel,
                    t('add.settlement'),
                    locale,
                  )}
                >
                  <Text variant="body" style={styles.historyText} numberOfLines={2}>
                    {formatActivityRow(entry, memberName, unitLabel, t('add.settlement'), locale)}
                  </Text>
                </TouchableOpacity>
              ))}
              {historyPage.hasMore && (
                <TouchableOpacity
                  style={styles.loadMoreBtn}
                  disabled={historyLoading}
                  onPress={() => { void loadHistoryPage(historyFilter, historyPage.cursor); }}
                >
                  <Text variant="caption" color={colors.textSecondary}>
                    {historyLoading ? t('state.loading') : t('action.loadMore')}
                  </Text>
                </TouchableOpacity>
              )}
            </>
          ) : (
            <Text variant="body" style={styles.emptyText}>
              {historyLoading ? t('state.loading') : historyError ? '' : t('balances.emptyActivity')}
            </Text>
          )}
        </Card>
      </View>

      {/* ── Historical entry actions (Edit / Delete / Share) ── */}
      <Modal
        visible={selectedEntry !== null}
        animationType="fade"
        transparent
        onRequestClose={closeEntryActions}
      >
        <TouchableOpacity
          style={styles.actionSheetBackdrop}
          activeOpacity={1}
          onPress={closeEntryActions}
        >
          <View style={styles.actionSheet}>
            <Text variant="sectionTitle" style={styles.actionSheetTitle}>
              {t('balances.entryActions')}
            </Text>
            {selectedEntry && (
              <Text
                variant="caption"
                color={colors.textSecondary}
                style={styles.actionSheetSummary}
                numberOfLines={2}
              >
                {formatActivityRow(selectedEntry, memberName, unitLabel, t('add.settlement'), locale)}
              </Text>
            )}

            {selectedEntry && selectedEntry.type !== 'cross-ledger-settlement' && (
              <>
                <TouchableOpacity
                  testID="balances.editEntry"
                  style={styles.actionSheetButton}
                  onPress={() => handleEditEntry(selectedEntry)}
                  accessibilityRole="button"
                >
                  <Text variant="body">
                    {selectedEntry.type === 'contribution'
                      ? t('balances.editTask')
                      : t('balances.editExpense')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="balances.deleteEntry"
                  style={styles.actionSheetButton}
                  onPress={() => handleDeleteEntry(selectedEntry)}
                  accessibilityRole="button"
                >
                  <Text variant="body" color={colors.balanceNegative}>
                    {t('balances.deleteEntry')}
                  </Text>
                </TouchableOpacity>
              </>
            )}

            {selectedEntry && (
              <TouchableOpacity
                testID="balances.shareEntry"
                style={styles.actionSheetButton}
                onPress={() => handleShareEntry(selectedEntry)}
                accessibilityRole="button"
              >
                <Text variant="body">{t('balances.shareEntry')}</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              testID="balances.closeEntryActions"
              style={styles.actionSheetButton}
              onPress={closeEntryActions}
              accessibilityRole="button"
            >
              <Text variant="body" color={colors.textSecondary}>
                {t('action.cancel')}
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── Compenser Modal ─────────────────────────────────── */}
      <Modal
        visible={showCompenser}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowCompenser(false)}
      >
        <ScreenContainer>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text variant="screenTitle">{t('balances.composerTitle')}</Text>
              <TouchableOpacity onPress={() => setShowCompenser(false)}>
                <Text variant="bodyBold" color={colors.textSecondary}>{t('action.close')}</Text>
              </TouchableOpacity>
            </View>

            <Text variant="body" style={styles.modalLabel}>
              {t('balances.composerCreditor')}
            </Text>
            <View style={styles.memberSelectRow}>
              {memberIds.map((mid) => (
                <TouchableOpacity
                  key={mid}
                  style={[
                    styles.memberSelectBtn,
                    compenserCreditor === mid && styles.memberSelectBtnActive,
                  ]}
                  onPress={() => setCompenserCreditor(mid)}
                  testID={`balances.compenserCreditor.${mid}`}
                >
                  <Text
                    variant="caption"
                    color={compenserCreditor === mid ? colors.textOnPrimary : colors.text}
                  >
                    {memberName(mid)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text variant="body" style={styles.modalLabel}>
              {t('balances.composerValue', { unit: unitLabel })}
            </Text>
            <View style={styles.inputRow}>
              {['15', '30', '60'].map((preset) => (
                <TouchableOpacity
                  key={preset}
                  style={[styles.presetBtn, compenserValue === preset && styles.presetBtnActive]}
                  onPress={() => setCompenserValue(preset)}
                  testID={`balances.compenserPreset.${preset}`}
                >
                  <Text variant="caption" color={compenserValue === preset ? colors.textOnPrimary : colors.text}>
                    {preset}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TextInput
              testID="balances.compenserValue"
              value={compenserValue}
              onChangeText={setCompenserValue}
              keyboardType="decimal-pad"
              accessibilityLabel={t('balances.composerValue', { unit: unitLabel })}
              style={{ minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.sm, padding: spacing.md, color: colors.text }}
            />

            {compenserPreview && (
              <Card style={styles.previewCard}>
                <Text variant="bodyBold" style={{ marginBottom: spacing.sm }}>
                  {t('balances.composerBeforeAfter')}
                </Text>
                <Text variant="caption" color={colors.textSecondary} style={{ marginBottom: spacing.xs }}>
                  {t('balances.composerTasks', { unit: unitLabel })}
                </Text>
                {compenserPreview.contribBefore.map((b) => {
                  const after = compenserPreview.contribAfter.find((a) => a.memberId === b.memberId);
                  return (
                    <View key={b.memberId} style={styles.previewRow}>
                      <Text variant="body" style={{ flex: 1 }}>{memberName(b.memberId)}</Text>
                      <Text variant="body" style={{ width: 80, textAlign: 'right' }}>
                        {formatContributionValue(b.value, unitLabel, locale)}
                      </Text>
                      <Text variant="body" style={{ width: 20, textAlign: 'center' }}>→</Text>
                      <Text variant="body" style={{ width: 80, textAlign: 'right' }}>
                        {formatContributionValue(after?.value ?? b.value, unitLabel, locale)}
                      </Text>
                    </View>
                  );
                })}

                <Text variant="caption" color={colors.textSecondary} style={{ marginTop: spacing.md, marginBottom: spacing.xs }}>
                  {t('balances.composerMoney', { currency: compenserPreview.rate.currency })}
                </Text>
                {compenserPreview.moneyBefore.map((b) => {
                  const after = compenserPreview.moneyAfter.find((a) => a.memberId === b.memberId);
                  return (
                    <View key={b.memberId} style={styles.previewRow}>
                      <Text variant="body" style={{ flex: 1 }}>{memberName(b.memberId)}</Text>
                      <Text variant="body" style={{ width: 80, textAlign: 'right' }}>
                        {formatMoneyAmount(b.amountMinor, b.currency, locale)}
                      </Text>
                      <Text variant="body" style={{ width: 20, textAlign: 'center' }}>→</Text>
                      <Text variant="body" style={{ width: 80, textAlign: 'right' }}>
                        {formatMoneyAmount(after?.amountMinor ?? b.amountMinor, b.currency, locale)}
                      </Text>
                    </View>
                  );
                })}

                <Text variant="caption" color={colors.textSecondary} style={{ marginTop: spacing.md }}>
                  {t('balances.composerRateSnapshot', {
                    value: formatQuantity(compenserPreview.rate.contributionValue, locale),
                    unit: unitLabel,
                    money: formatCurrencyAmount(
                      compenserPreview.rate.moneyAmountMinor,
                      compenserPreview.rate.currency,
                      locale,
                    ),
                  })}
                </Text>
                <Text variant="caption" color={colors.textSecondary}>
                  {t('balances.composerAmount', {
                    amount: formatCurrencyAmount(
                      compenserPreview.moneyAmount,
                      compenserPreview.rate.currency,
                      locale,
                    ),
                  })}
                </Text>
              </Card>
            )}

            {compenserError && (
              <Text variant="body" color={colors.balanceNegative} style={{ marginTop: spacing.sm }}>
                {compenserError}
              </Text>
            )}

            <Button
              title={t('balances.composerConfirm')}
              disabled={!compenserPreview || isCompensating}
              loading={isCompensating}
              onPress={handleCompenserConfirm}
              style={{ marginTop: spacing.lg }}
              testID="balances.compenserConfirm"
            />
          </View>
        </ScreenContainer>
      </Modal>
    </ScreenContainer>
  );
}

// ── Styles ─────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: 40,
  },
  header: {
    marginBottom: spacing.lg,
  },
  periodSwitch: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceAlt,
    borderRadius: borderRadius.md,
    padding: 2,
    marginBottom: spacing.lg,
    gap: 2,
  },
  periodButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.sm,
  },
  periodButtonActive: {
    backgroundColor: colors.primary,
  },
  sectionTitle: {
    marginBottom: spacing.md,
    marginTop: spacing.sm,
  },
  balanceCard: {
    marginBottom: spacing.md,
  },
  balanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  memberName: {
    flex: 1,
  },
  zeroSumBadge: {
    alignItems: 'center',
    paddingTop: spacing.sm,
    marginTop: spacing.xs,
  },
  suggestionCard: {
    marginBottom: spacing.md,
    backgroundColor: colors.surfaceAlt,
  },
  suggestionHeader: {
    marginBottom: spacing.sm,
  },
  suggestionRow: {
    paddingVertical: spacing.xs,
  },
  suggestionText: {
    fontSize: 14,
  },
  emptyText: {
    color: colors.textSecondary,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  },
  compensationCard: {
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  compensationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  statusBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.sm,
  },
  statusEnabled: {
    backgroundColor: colors.balancePositive,
  },
  statusDisabled: {
    backgroundColor: colors.textMuted,
  },
  compensationDescription: {
    lineHeight: 20,
  },
  // History section
  historyFilterRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  historyFilterBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.surfaceAlt,
  },
  historyFilterBtnActive: {
    backgroundColor: colors.primary,
  },
  historyCard: {
    marginBottom: spacing.md,
  },
  historyRow: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  historyText: {
    fontSize: 14,
    lineHeight: 20,
  },
  loadMoreBtn: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  // Entry action sheet (Edit / Delete / Share)
  actionSheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    justifyContent: 'flex-end',
  },
  actionSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: 40,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  actionSheetTitle: {
    marginBottom: spacing.xs,
  },
  actionSheetSummary: {
    marginBottom: spacing.md,
  },
  actionSheetButton: {
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  // Compenser modal
  modalContent: {
    padding: spacing.xl,
    paddingBottom: 60,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  modalLabel: {
    marginBottom: spacing.sm,
    marginTop: spacing.md,
  },
  memberSelectRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  memberSelectBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  memberSelectBtnActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  inputRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  presetBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  presetBtnActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  previewCard: {
    marginTop: spacing.md,
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
});
