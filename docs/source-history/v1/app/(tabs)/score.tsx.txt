import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/src/components/Avatar';
import { Card } from '@/src/components/Card';
import { DemoBanner } from '@/src/components/DemoBanner';
import { MemberBarChart } from '@/src/components/MemberBarChart';
import { MetricCard } from '@/src/components/MetricCard';
import { NoticeBanner } from '@/src/components/NoticeBanner';
import { Screen } from '@/src/components/Screen';
import { ScreenHeader } from '@/src/components/ScreenHeader';
import { SectionTitle } from '@/src/components/SectionTitle';
import { SegmentedControl } from '@/src/components/SegmentedControl';
import { COLORS, RADIUS, SPACING } from '@/src/components/theme';
import { getEntitlements, getPlanLabel } from '@/src/domain/entitlements';
import { buildScoreShareText, formatDurationHuman, shareText } from '@/src/services/shareService';
import { buildLeaderboard, getVisibleHistory } from '@/src/domain/leaderboard';
import { isEntryInPeriod } from '@/src/domain/periods';
import {
  FILTER_ALL,
  buildMemberBarData,
  buildScoreFilterOptions,
  filterEntriesByTask,
  hasArchivedTaskEntries,
  hasWeightedContent,
} from '@/src/domain/scoreFilters';
import { formatMetric, getEntryValue } from '@/src/domain/scoring';
import type { TaskEntry } from '@/src/domain/types';
import { useApp } from '@/src/store/AppProvider';

type ScorePeriod = 'week' | 'month' | 'year' | 'all';

const PERIOD_OPTIONS = [
  { value: 'week', label: 'Semaine' },
  { value: 'month', label: 'Mois' },
  { value: 'year', label: 'Année' },
  { value: 'all', label: 'Depuis le début' },
];

function filterByScorePeriod(
  entries: TaskEntry[],
  householdId: string,
  period: ScorePeriod,
  now: Date,
): TaskEntry[] {
  return entries.filter((entry) => {
    if (
      entry.householdId !== householdId ||
      entry.status !== 'completed' ||
      entry.completedAt === null
    ) {
      return false;
    }
    if (period === 'all') return true;
    if (period === 'year') {
      const completedAt = new Date(entry.completedAt);
      return completedAt.getFullYear() === now.getFullYear();
    }
    return isEntryInPeriod(entry, period, now);
  });
}

export default function ScoreScreen() {
  const { state, dismissNotice } = useApp();
  const [period, setPeriod] = useState<ScorePeriod>('week');
  const [taskFilter, setTaskFilter] = useState<string>(FILTER_ALL);
  const entitlements = getEntitlements(state.household.plan);
  const now = new Date();

  // Step 1: filter by period
  const periodEntries = useMemo(
    () => filterByScorePeriod(state.entries, state.household.id, period, now),
    [state.entries, state.household.id, period, now],
  );

  // Step 2: filter by task (on top of period filter)
  const filteredEntries = useMemo(
    () => filterEntriesByTask(periodEntries, state.tasks, state.household.id, taskFilter),
    [periodEntries, state.tasks, state.household.id, taskFilter],
  );

  // Build task filter options
  const archivedExist = useMemo(
    () => hasArchivedTaskEntries(periodEntries, state.tasks, state.household.id),
    [periodEntries, state.tasks, state.household.id],
  );

  const taskFilterOptions = useMemo(
    () => buildScoreFilterOptions(state.tasks, state.household.id, archivedExist),
    [state.tasks, state.household.id, archivedExist],
  );

  // Reset task filter if the selected option no longer exists
  useEffect(() => {
    if (taskFilter !== FILTER_ALL && !taskFilterOptions.some((opt) => opt.value === taskFilter)) {
      setTaskFilter(FILTER_ALL);
    }
  }, [taskFilterOptions, taskFilter]);

  // Leaderboard rows (for ranking section) — always built from all period entries
  // to show the full household ranking regardless of task filter
  const rows = useMemo(() => {
    if (period === 'week' || period === 'month') {
      return buildLeaderboard(
        state.entries,
        state.users,
        state.memberships,
        state.household.id,
        period,
        now,
        entitlements.useWeights,
      );
    }
    // For year and all-time, build from period entries (not task-filtered)
    const memberIds = new Set(
      state.memberships
        .filter((m) => m.householdId === state.household.id)
        .map((m) => m.userId),
    );
    const unsorted = state.users
      .filter((user) => memberIds.has(user.id))
      .map((user) => {
        const userEntries = periodEntries.filter((entry) => entry.userId === user.id);
        return {
          user,
          rank: 0,
          value: userEntries.reduce(
            (sum, entry) =>
              sum + (entitlements.useWeights ? entry.score : entry.durationSeconds / 60),
            0,
          ),
          durationMinutes: userEntries.reduce(
            (sum, entry) => sum + entry.durationSeconds / 60,
            0,
          ),
          taskCount: userEntries.length,
          contribution: 0,
        };
      })
      .sort((a, b) => b.value - a.value || a.user.name.localeCompare(b.user.name, 'fr'));

    const total = unsorted.reduce((sum, row) => sum + row.value, 0);
    let previousValue: number | null = null;
    let currentRank = 0;

    return unsorted.map((row, index) => {
      if (previousValue === null || Math.abs(row.value - previousValue) > Number.EPSILON) {
        currentRank = index + 1;
        previousValue = row.value;
      }
      return {
        ...row,
        rank: currentRank,
        contribution: total === 0 ? 0 : (row.value / total) * 100,
      };
    });
  }, [filteredEntries, periodEntries, state.users, state.memberships, state.household.id, period, now, entitlements.useWeights]);

  const hasEntries = rows.some((row) => row.taskCount > 0);

  // Member bar data — built from task-filtered entries (not all period entries)
  const memberBarData = useMemo(
    () => buildMemberBarData(filteredEntries, state.users, state.household.id, entitlements.useWeights),
    [filteredEntries, state.users, state.household.id, entitlements.useWeights],
  );

  // Weighted view: show when any task-filtered entry has a weight ≠ 1
  const showWeighted = useMemo(
    () => entitlements.useWeights && hasWeightedContent(filteredEntries),
    [entitlements.useWeights, filteredEntries],
  );

  // Weighted member bar data
  const weightedBarData = useMemo(() => {
    if (!showWeighted) return [];
    // Recompute with useWeights = true
    return buildMemberBarData(filteredEntries, state.users, state.household.id, true);
  }, [showWeighted, filteredEntries, state.users, state.household.id]);

  // Weighted totals for secondary metrics
  const weightedTotalMinutes = useMemo(
    () => filteredEntries.reduce((sum, e) => sum + e.durationSeconds / 60 * e.weightSnapshot, 0),
    [filteredEntries],
  );

  const changePeriod = (value: string) => {
    // DRC-04 : les 4 périodes sont cœur produit, pas premium.
    if (
      value === 'week' ||
      value === 'month' ||
      value === 'year' ||
      value === 'all'
    ) {
      setPeriod(value as ScorePeriod);
    }
  };

  const totalMinutes = rows.reduce((sum, row) => sum + row.durationMinutes, 0);

  // History lookup maps for the filtered history section
  const taskById = useMemo(() => new Map(state.tasks.map((task) => [task.id, task])), [state.tasks]);
  const userById = useMemo(() => new Map(state.users.map((user) => [user.id, user])), [state.users]);

  // Current task filter label for section title
  const taskFilterLabel = useMemo(() => {
    if (taskFilter === FILTER_ALL) return null;
    const option = taskFilterOptions.find((opt) => opt.value === taskFilter);
    return option?.label ?? null;
  }, [taskFilter, taskFilterOptions]);

  return (
    <Screen>
      <DemoBanner />
      <ScreenHeader
        eyebrow={`${state.household.name} · ${getPlanLabel(state.household.plan)}`}
        title="Score"
        subtitle="Équilibres et contribution de chaque membre du foyer."
      />
      <NoticeBanner message={state.notice} onDismiss={dismissNotice} />

      <SegmentedControl
        accessibilityLabel="Période du score"
        options={PERIOD_OPTIONS.map((opt) => ({
          value: opt.value,
          label: opt.label,
        }))}
        value={period}
        onChange={changePeriod}
        wrap
      />

      {/* Task filter selector: Toutes | PersistentTask | Autres */}
      <SegmentedControl
        accessibilityLabel="Filtre de tâche"
        options={taskFilterOptions}
        value={taskFilter}
        onChange={setTaskFilter}
        wrap
      />

      <View style={styles.metricRow}>
        <MetricCard
          label="Temps total"
          value={`${Math.round(filteredEntries.reduce((sum, e) => sum + e.durationSeconds / 60, 0))} min`}
          detail={`${filteredEntries.length} ${filteredEntries.length > 1 ? 'entrées' : 'entrée'} dans la sélection`}
        />
        {entitlements.useWeights ? (
          <MetricCard
            label="Poids total"
            value={`${Math.round(filteredEntries.reduce(
              (sum, entry) => sum + getEntryValue(entry, true),
              0,
            ))} pts`}
            detail="durée × poids convenu"
          />
        ) : null}
      </View>

      {/* Member bar chart with names */}
      <SectionTitle
        title="Contribution par membre"
        detail={taskFilterLabel !== null ? `Filtré : ${taskFilterLabel}` : 'Temps par membre'}
      />
      {memberBarData.length === 0 ? (
        <Card style={styles.empty}>
          <Text style={styles.emptyTitle}>Pas encore de données</Text>
          <Text style={styles.emptyText}>
            Les membres apparaîtront ici dès qu'une tâche sera terminée.
          </Text>
        </Card>
      ) : (
        <MemberBarChart
          data={memberBarData}
          unit={entitlements.useWeights ? 'pts' : 'min'}
          showValue={entitlements.useWeights}
        />
      )}

      {/* Équilibres section */}
      <SectionTitle title="Équilibres" detail="Classement par contribution du foyer" />

      {!hasEntries ? (
        <Card style={styles.empty}>
          <Text style={styles.emptyTitle}>Pas encore de données</Text>
          <Text style={styles.emptyText}>
            Les membres apparaîtront ici dès qu'une tâche sera terminée.
          </Text>
        </Card>
      ) : (
        <View style={styles.list}>
          {rows.map((row) => {
            const isCurrentUser = row.user.id === state.currentUserId;
            return (
              <Card key={row.user.id} style={isCurrentUser ? styles.currentCard : undefined}>
                <View style={styles.rowTop}>
                  <Text style={styles.rank}>#{row.rank}</Text>
                  <Avatar initials={row.user.initials} color={row.user.color} />
                  <View style={styles.memberCopy}>
                    <Text style={styles.memberName}>
                      {row.user.name}
                      {isCurrentUser ? ' · toi' : ''}
                    </Text>
                    <Text style={styles.memberMeta}>
                      {row.taskCount} tâches · {Math.round(row.durationMinutes)} min saisies
                    </Text>
                  </View>
                  <Text style={styles.score}>
                    {formatMetric(row.value, entitlements.useWeights)}
                  </Text>
                </View>
                <View style={styles.progressWrap}>
                  <View
                    style={[
                      styles.progressBar,
                      { width: `${Math.max(row.contribution, 2)}%` },
                    ]}
                  />
                </View>
              </Card>
            );
          })}
        </View>
      )}

      {/* Weighted secondary view */}
      {showWeighted && weightedBarData.length > 0 ? (
        <>
          <SectionTitle
            title="Vue pondérée"
            detail={`${Math.round(weightedTotalMinutes)} pts pondérés · Filtre : ${taskFilterLabel ?? 'Toutes'}`}
          />
          <MemberBarChart
            data={weightedBarData}
            unit="pts"
            showValue
          />
        </>
      ) : null}

      {/* Filtered history under stats */}
      <SectionTitle
        title="Historique filtré"
        detail={`${filteredEntries.length} ${filteredEntries.length > 1 ? 'entrées' : 'entrée'} — ${taskFilterLabel ?? 'Toutes'} · ${
          period === 'week'
            ? 'Semaine'
            : period === 'month'
              ? 'Mois'
              : period === 'year'
                ? 'Année'
                : 'Depuis le début'
        }`}
      />
      {filteredEntries.length === 0 ? (
        <Card style={styles.empty}>
          <Text style={styles.emptyTitle}>Aucune entrée</Text>
          <Text style={styles.emptyText}>
            Aucune entrée ne correspond à la période et au filtre sélectionnés.
          </Text>
        </Card>
      ) : (
        <View style={styles.list}>
          {filteredEntries.slice(0, 30).map((entry) => {
            const task = taskById.get(entry.taskId);
            const user = userById.get(entry.userId);
            const completedAt = entry.completedAt === null ? null : new Date(entry.completedAt);
            return (
              <Card key={entry.id}>
                <View style={styles.historyRow}>
                  <View style={styles.historyCopy}>
                    <Text style={styles.historyName}>{task?.name ?? 'Tâche archivée'}</Text>
                    <Text style={styles.historyMeta}>
                      {user?.name ?? 'Membre'} · {entry.isManual ? 'saisie manuelle' : 'chrono'} ·{' '}
                      {completedAt === null
                        ? ''
                        : new Intl.DateTimeFormat('fr-CH', { day: '2-digit', month: 'short' }).format(completedAt)}
                    </Text>
                  </View>
                  <View style={styles.historyValueWrap}>
                    <Text style={styles.historyValue}>
                      {formatMetric(getEntryValue(entry, entitlements.useWeights), entitlements.useWeights)}
                    </Text>
                    <Text style={styles.historyMinutes}>{Math.round(entry.durationSeconds / 60)} min</Text>
                  </View>
                </View>
              </Card>
            );
          })}
        </View>
      )}

      {/* DRC-05 : Partage système natif du Score courant */}
      {rows.some((row) => row.taskCount > 0) ? (
        <Pressable
          onPress={() => {
            const periodLabel =
              period === 'week' ? 'Semaine' : period === 'month' ? 'Mois' : period === 'year' ? 'Année' : 'Depuis le début';
            const text = buildScoreShareText({
              householdName: state.household.name,
              periodLabel,
              filterLabel: taskFilterLabel ?? 'Toutes',
              totalMinutes: totalMinutes,
              rows: rows
                .filter((row) => row.taskCount > 0)
                .map((row) => ({
                  name: row.user.name,
                  durationMinutes: row.durationMinutes,
                  rank: row.rank,
                })),
            });
            shareText(text);
          }}
          style={styles.shareButton}
          accessibilityLabel="Partager le score"
        >
          <Text style={styles.shareButtonText}>Partager le score</Text>
        </Pressable>
      ) : null}

    </Screen>
  );
}

const styles = StyleSheet.create({
  metricRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  list: {
    gap: SPACING.sm,
    marginTop: SPACING.sm,
  },
  currentCard: {
    borderColor: COLORS.success,
    backgroundColor: '#F8F4EF',
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  rank: {
    width: 28,
    color: COLORS.textSecondary,
    fontWeight: '800',
  },
  memberCopy: {
    flex: 1,
  },
  memberName: {
    color: COLORS.textPrimary,
    fontWeight: '800',
    fontSize: 16,
  },
  memberMeta: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  score: {
    color: COLORS.textPrimary,
    fontWeight: '800',
    fontSize: 14,
  },
  progressWrap: {
    marginLeft: 80,
    marginTop: SPACING.sm,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.surfaceAlt,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: COLORS.primary,
  },
  empty: {
    padding: SPACING.lg,
    alignItems: 'center',
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.surfaceAlt,
    marginTop: SPACING.md,
  },
  emptyTitle: {
    color: COLORS.textPrimary,
    fontWeight: '800',
  },
  emptyText: {
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginTop: SPACING.xs,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  historyCopy: {
    flex: 1,
  },
  historyName: {
    color: COLORS.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  historyMeta: {
    color: COLORS.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
  },
  historyValueWrap: {
    alignItems: 'flex-end',
  },
  historyValue: {
    color: COLORS.textPrimary,
    fontWeight: '800',
    fontSize: 13,
  },
  historyMinutes: {
    color: COLORS.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  shareButton: {
    marginTop: SPACING.lg,
    marginBottom: SPACING.md,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
  },
  shareButtonText: {
    color: COLORS.textPrimary,
    fontWeight: '700',
    fontSize: 14,
  },
});
