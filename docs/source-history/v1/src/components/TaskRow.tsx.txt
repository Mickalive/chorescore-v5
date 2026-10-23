import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { TaskDefinition, TaskEntry } from '../domain/types';
import { AppButton } from './AppButton';
import { Card } from './Card';
import { COLORS, RADIUS, SPACING } from './theme';

const CATEGORY_LABELS: Record<TaskDefinition['category'], string> = {
  dishes: 'Vaisselle',
  cooking: 'Cuisine',
  cleaning: 'Nettoyage',
  laundry: 'Linge',
  shopping: 'Courses',
  other: 'Autre',
};

function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return [hours, minutes, remainingSeconds].map((value) => String(value).padStart(2, '0')).join(':');
}

export function TaskRow({
  task,
  activeEntry,
  useWeights,
  onStart,
  onStop,
  onManual,
  onEdit,
  onArchive,
  onCancelTimer,
}: {
  task: TaskDefinition;
  activeEntry: TaskEntry | null;
  useWeights: boolean;
  onStart: () => void;
  onStop: () => void;
  onManual: () => void;
  /** DRC-03 : ouvre la modification de la définition (jamais proposé pendant un chrono). */
  onEdit: () => void;
  /** DRC-03 : archivage confirmé — la tâche quitte les propositions, l'historique reste libellé. */
  onArchive: () => void;
  /** DRC-03 : annulation confirmée du chrono actif — aucune entrée fantôme. */
  onCancelTimer: (entryId: string) => void;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (activeEntry?.startedAt === null || activeEntry === null) {
      setElapsed(0);
      return undefined;
    }
    const update = () => {
      setElapsed(Math.max(0, Math.floor((Date.now() - new Date(activeEntry.startedAt ?? '').getTime()) / 1000)));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [activeEntry]);

  return (
    <Card style={activeEntry === null ? undefined : styles.activeCard}>
      <View style={styles.topRow}>
        <View style={styles.copy}>
          <Text style={styles.name}>{task.name}</Text>
          <Text style={styles.meta}>
            {CATEGORY_LABELS[task.category]}
          </Text>
        </View>
      </View>

      {activeEntry === null ? (
        <View style={styles.actions}>
          <AppButton
            label="Démarrer"
            accessibilityLabel={`Démarrer le chrono de ${task.name}`}
            onPress={onStart}
            style={styles.actionButton}
          />
          <AppButton
            label="Saisir un temps"
            accessibilityLabel={`Saisir un temps pour ${task.name}`}
            variant="secondary"
            onPress={onManual}
            style={styles.actionButton}
          />
          <AppButton
            label="Modifier"
            accessibilityLabel={`Modifier la tâche ${task.name}`}
            variant="ghost"
            onPress={onEdit}
            style={styles.actionButton}
          />
          <AppButton
            label="Archiver"
            accessibilityLabel={`Archiver la tâche ${task.name}`}
            variant="danger"
            onPress={onArchive}
            style={styles.actionButton}
          />
        </View>
      ) : (
        <View style={styles.timerRow} accessibilityLiveRegion="polite">
          <View>
            <Text style={styles.timerLabel}>Chrono en cours</Text>
            <Text style={styles.timer}>{formatElapsed(elapsed)}</Text>
          </View>
          <View style={styles.timerActions}>
            <AppButton
              label="Annuler"
              accessibilityLabel={`Annuler le chrono de ${task.name} sans enregistrer`}
              variant="ghost"
              onPress={() => onCancelTimer(activeEntry.id)}
              style={styles.cancelButton}
            />
            <AppButton
              label="Terminer"
              accessibilityLabel={`Terminer le chrono de ${task.name}`}
              onPress={onStop}
            />
          </View>
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  activeCard: {
    borderColor: COLORS.success,
    backgroundColor: '#F8F4EF',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
  },
  copy: {
    flex: 1,
  },
  name: {
    color: COLORS.textPrimary,
    fontWeight: '800',
    fontSize: 17,
  },
  meta: {
    color: COLORS.textSecondary,
    marginTop: 3,
    fontSize: 13,
  },

  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  actionButton: {
    flex: 1,
    minWidth: 132,
  },
  timerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: SPACING.md,
    gap: SPACING.sm,
  },
  timerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  cancelButton: {
    minWidth: 96,
  },
  timerLabel: {
    color: COLORS.success,
    fontWeight: '700',
    fontSize: 12,
  },
  timer: {
    color: COLORS.textPrimary,
    fontVariant: ['tabular-nums'],
    fontSize: 22,
    fontWeight: '800',
    marginTop: 2,
  },
});
