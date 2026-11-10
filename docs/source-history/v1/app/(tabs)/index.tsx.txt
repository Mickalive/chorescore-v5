import { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { AppButton } from '@/src/components/AppButton';
import { Card } from '@/src/components/Card';
import { DemoBanner } from '@/src/components/DemoBanner';
import { EntryCorrectionModal } from '@/src/components/EntryCorrectionModal';
import { ManualEntryModal } from '@/src/components/ManualEntryModal';
import { MetricCard } from '@/src/components/MetricCard';
import { NoticeBanner } from '@/src/components/NoticeBanner';
import { Screen } from '@/src/components/Screen';
import { ScreenHeader } from '@/src/components/ScreenHeader';
import { SectionTitle } from '@/src/components/SectionTitle';
import { TaskFormModal } from '@/src/components/TaskFormModal';
import { TaskRow } from '@/src/components/TaskRow';
import { COLORS, RADIUS, SPACING } from '@/src/components/theme';
import { getEntitlements, getPlanLabel } from '@/src/domain/entitlements';
import { buildLeaderboard, getVisibleHistory } from '@/src/domain/leaderboard';
import { formatMetric } from '@/src/domain/scoring';
import type { TaskDefinition, TaskEntry } from '@/src/domain/types';
import { selectVisibleTasks } from '@/src/store/appReducer';
import { useApp } from '@/src/store/AppProvider';

export default function TasksScreen() {
  const {
    state,
    addTask,
    updateTask,
    archiveTask,
    startTimer,
    completeTimer,
    cancelTimer,
    addManualEntry,
    editEntryDuration,
    deleteEntry,
    showPaywall,
    dismissNotice,
  } = useApp();
  const [taskFormVisible, setTaskFormVisible] = useState(false);
  const [editTask, setEditTask] = useState<TaskDefinition | null>(null);
  const [manualTask, setManualTask] = useState<TaskDefinition | null>(null);
  const [correctingEntry, setCorrectingEntry] = useState<TaskEntry | null>(null);
  const entitlements = getEntitlements(state.household.plan);
  const currentUser = state.users.find((user) => user.id === state.currentUserId);
  const weeklyRows = useMemo(
    () =>
      buildLeaderboard(
        state.entries,
        state.users,
        state.memberships,
        state.household.id,
        'week',
        new Date(),
        entitlements.useWeights,
      ),
    [state.entries, state.household.id, state.memberships, state.users, entitlements.useWeights],
  );
  const currentRow = weeklyRows.find((row) => row.user.id === state.currentUserId);
  const completedThisWeek = currentRow?.taskCount ?? 0;
  const currentMetric = currentRow?.value ?? 0;
  // DRC-04 : seules les tâches du foyer actif sont proposées — les foyers
  // locaux sont isolés dans la liste comme dans le document persisté.
  const activeTasks = selectVisibleTasks(state);
  const archivedCount = state.tasks.filter(
    (task) => task.householdId === state.household.id && !task.active,
  ).length;

  // DRC-01 : les membres du foyer servent au sélecteur « Fait par ».
  const householdMembers = state.users.filter((user) =>
    state.memberships.some(
      (m) => m.householdId === state.household.id && m.userId === user.id,
    ),
  );

  // Historique chronologique complet du foyer
  const visibleEntries = useMemo(
    () => getVisibleHistory(state.entries, state.household.id, entitlements.historyDays, new Date()),
    [state.entries, state.household.id, entitlements.historyDays],
  );
  const taskById = useMemo(() => new Map(state.tasks.map((task) => [task.id, task])), [state.tasks]);
  const userById = useMemo(() => new Map(state.users.map((user) => [user.id, user])), [state.users]);

  // DRC-03 : l'archivage est réel mais jamais silencieux — confirmation
  // explicite avant de retirer la tâche des propositions.
  const confirmArchive = (task: TaskDefinition) => {
    Alert.alert(
      'Archiver cette tâche ?',
      `« ${task.name} » ne sera plus proposée aux nouveaux chronos. Les temps déjà enregistrés restent visibles dans l’historique.`,
      [
        { text: 'Conserver', style: 'cancel' },
        { text: 'Archiver', style: 'destructive', onPress: () => archiveTask(task.id) },
      ],
    );
  };

  // DRC-03 : annulation déterministe d'un chrono actif, confirmée — le temps
  // écoulé est ignoré et aucune entrée n'est créée.
  const confirmCancelTimer = (activeEntry: TaskEntry) => {
    Alert.alert('Annuler ce chrono ?', 'Le temps écoulé sera ignoré : aucune entrée ne sera créée.', [
      { text: 'Continuer le chrono', style: 'cancel' },
      { text: 'Annuler le chrono', style: 'destructive', onPress: () => cancelTimer(activeEntry.id) },
    ]);
  };

  // DRC-03 (PRODUCT-RESET-DATA) : suppression confirmée d'une entrée
  // libre du journal. Modèle de confiance : chaque membre peut
  // corriger/supprimer ses propres entrées.
  const confirmDeleteEntry = (entry: TaskEntry) => {
    const taskName = taskById.get(entry.taskId)?.name ?? 'Tâche archivée';
    Alert.alert(
      'Supprimer cette entrée ?',
      `« ${taskName} » — ${Math.round(entry.durationSeconds / 60)} min seront retirées de l'historique.`,
      [
        { text: 'Conserver', style: 'cancel' },
        { text: 'Supprimer', style: 'destructive', onPress: () => deleteEntry(entry.id) },
      ],
    );
  };

  return (
    <Screen>
      <DemoBanner />
      <ScreenHeader
        eyebrow={`${state.household.name} · ${getPlanLabel(state.household.plan)}`}
        title={`Bonjour ${currentUser?.name ?? ''}`}
        subtitle="Enregistre ce qui a été fait."
      />
      <NoticeBanner message={state.notice} onDismiss={dismissNotice} />

      <View style={styles.metricRow}>
        <MetricCard
          label="Cette semaine"
          value={formatMetric(currentMetric, false)}
          detail={`${completedThisWeek} ${completedThisWeek > 1 ? 'tâches' : 'tâche'} saisies`}
        />
      </View>

      <View style={styles.sectionRow}>
        <SectionTitle title="Tâches du foyer" detail={`${activeTasks.length} tâches actives`} />
        <AppButton label="Ajouter" onPress={() => setTaskFormVisible(true)} style={styles.addButton} />
      </View>

      {activeTasks.length === 0 ? (
        <Card style={styles.emptyState}>
          <Text style={styles.emptyTitle}>Aucune tâche active</Text>
          <Text style={styles.emptyText}>
            Ajoutez une première tâche pour commencer à enregistrer le temps du foyer.
          </Text>
        </Card>
      ) : (
        <View style={styles.taskList}>
          {activeTasks.map((task) => {
            const activeEntry =
              state.entries.find(
                (entry) =>
                  entry.taskId === task.id &&
                  entry.userId === state.currentUserId &&
                  entry.status === 'in_progress',
              ) ?? null;
            return (
              <TaskRow
                key={task.id}
                task={task}
                activeEntry={activeEntry}
                useWeights={entitlements.useWeights}
                onStart={() => startTimer(task.id)}
                onStop={() => {
                  if (activeEntry !== null) completeTimer(activeEntry.id);
                }}
                onManual={() => setManualTask(task)}
                onEdit={() => setEditTask(task)}
                onArchive={() => confirmArchive(task)}
                onCancelTimer={(entryId) => {
                  if (activeEntry !== null && activeEntry.id === entryId) confirmCancelTimer(activeEntry);
                }}
              />
            );
          })}
        </View>
      )}

      {archivedCount > 0 ? (
        <Text style={styles.archivedNote}>
          {archivedCount} {archivedCount > 1 ? 'tâches archivées' : 'tâche archivée'} : plus proposée
          {archivedCount > 1 ? 's' : ''} aux nouveaux chronos, conservée
          {archivedCount > 1 ? 's' : ''} dans l’historique.
        </Text>
      ) : null}

      {/* Historique chronologique complet du foyer */}
      <View style={styles.historySection}>
        <SectionTitle
          title="Historique complet"
          detail={`${visibleEntries.length} ${visibleEntries.length > 1 ? 'entrées' : 'entrée'}`}
        />
        {visibleEntries.length === 0 ? (
          <Card style={styles.emptyState}>
            <Text style={styles.emptyTitle}>Aucune saisie</Text>
            <Text style={styles.emptyText}>
              Les temps enregistrés apparaîtront ici.
            </Text>
          </Card>
        ) : (
          <View style={styles.historyList}>
            {visibleEntries.slice(0, 20).map((entry) => {
              const task = taskById.get(entry.taskId);
              const user = userById.get(entry.userId);
              const completedAt = entry.completedAt === null ? null : new Date(entry.completedAt);
              const entryLabel = task?.name ?? 'Tâche archivée';
              const isOwnCompleted = entry.userId === state.currentUserId && entry.status === 'completed';
              return (
                <Card key={entry.id}>
                  <View style={styles.entryRow}>
                    <View style={styles.entryCopy}>
                      <Text style={styles.entryName}>{entryLabel}</Text>
                      <Text style={styles.entryMeta}>
                        {user?.name ?? 'Membre'} · {Math.round(entry.durationSeconds / 60)} min ·{' '}
                        {completedAt === null
                          ? ''
                          : new Intl.DateTimeFormat('fr-CH', { day: '2-digit', month: 'short' }).format(completedAt)}
                      </Text>
                    </View>
                    <View style={styles.entryActions}>
                      {isOwnCompleted ? (
                        <>
                          <Pressable
                            accessibilityLabel={`Corriger ${entryLabel}`}
                            onPress={() => setCorrectingEntry(entry)}
                            style={styles.entryAction}
                          >
                            <Text style={styles.entryActionText}>✏️</Text>
                          </Pressable>
                          <Pressable
                            accessibilityLabel={`Supprimer ${entryLabel}`}
                            onPress={() => confirmDeleteEntry(entry)}
                            style={styles.entryAction}
                          >
                            <Text style={styles.entryActionText}>🗑️</Text>
                          </Pressable>
                        </>
                      ) : null}
                    </View>
                  </View>
                </Card>
              );
            })}
          </View>
        )}
      </View>

      <TaskFormModal
        visible={taskFormVisible}
        canCustomizeWeight={entitlements.canCustomizeWeights}
        onClose={() => setTaskFormVisible(false)}
        onSubmit={addTask}
        onLockedWeight={() => showPaywall('custom_weights')}
      />
      <TaskFormModal
        visible={editTask !== null}
        canCustomizeWeight={entitlements.canCustomizeWeights}
        initialTask={editTask}
        onClose={() => setEditTask(null)}
        onSubmit={(input) => (editTask === null ? false : updateTask(editTask.id, input))}
        onLockedWeight={() => showPaywall('custom_weights')}
      />
      <ManualEntryModal
        task={manualTask}
        householdMembers={householdMembers}
        currentUserId={state.currentUserId}
        onClose={() => setManualTask(null)}
        onSubmit={(minutes, performedByMemberId) =>
          manualTask === null ? false : addManualEntry(manualTask.id, minutes, performedByMemberId)
        }
      />
      <EntryCorrectionModal
        entry={correctingEntry}
        taskName={
          correctingEntry === null
            ? ''
            : (taskById.get(correctingEntry.taskId)?.name ?? 'Tâche archivée')
        }
        useWeights={entitlements.useWeights}
        onClose={() => setCorrectingEntry(null)}
        onSubmit={(minutes) =>
          correctingEntry === null ? false : editEntryDuration(correctingEntry.id, minutes)
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  metricRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: SPACING.md,
  },
  addButton: {
    minWidth: 92,
    marginBottom: SPACING.sm,
  },
  taskList: {
    gap: SPACING.sm,
  },
  archivedNote: {
    color: COLORS.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    backgroundColor: COLORS.surfaceAlt,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
  },
  emptyState: {
    gap: SPACING.xs,
    backgroundColor: COLORS.surfaceAlt,
  },
  emptyTitle: {
    color: COLORS.textPrimary,
    fontWeight: '800',
  },
  emptyText: {
    // Contraste AA : textPrimary sur surfaceAlt ≈ 9,56:1 (constat F1 de l'audit
    // mobile 32688156479). textSecondary sur surfaceAlt atteint désormais ≈ 4,84:1
    // (≥ 4,5:1) grâce à l'ajustement MOB-CYCLE32961708279-SEG dans theme.ts.
    color: COLORS.textPrimary,
    lineHeight: 20,
  },
  historySection: {
    marginTop: SPACING.lg,
  },
  historyList: {
    gap: SPACING.sm,
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  entryCopy: {
    flex: 1,
  },
  entryName: {
    color: COLORS.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  entryMeta: {
    color: COLORS.textMuted,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  entryActions: {
    flexDirection: 'row',
    gap: SPACING.xs,
  },
  entryAction: {
    padding: SPACING.xs,
  },
  entryActionText: {
    fontSize: 14,
  },
});
