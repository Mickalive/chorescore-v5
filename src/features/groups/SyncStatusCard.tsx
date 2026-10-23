import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useApp } from '../app/AppContext';
import { useI18n } from '../../i18n';
import { SyncStatus } from '../../application/ports';
import { Card } from '../../ui/components/Card';
import { Button } from '../../ui/components/Button';
import { Text } from '../../ui/components/Text';
import { colors, spacing } from '../../ui/design-system/theme';

const EMPTY: SyncStatus = {
  isSyncing: false,
  lastSyncedAt: null,
  pendingChanges: 0,
  error: null,
  conflicts: 0,
};

export function SyncStatusCard({ householdId }: { householdId: string }) {
  const { t, locale } = useI18n();
  const { services, subscribeToDataChanges } = useApp();
  const [status, setStatus] = useState<SyncStatus>(EMPTY);
  const [retrying, setRetrying] = useState(false);
  const available = services.sync.isAvailable();

  const refresh = useCallback(async () => {
    if (!available) return;
    try {
      setStatus(await services.sync.getStatus(householdId));
    } catch {
      setStatus((current) => ({
        ...current,
        error: t('sync.unavailable'),
      }));
    }
  }, [available, householdId, services.sync, t]);

  useFocusEffect(useCallback(() => {
    void refresh();
  }, [refresh]));

  useEffect(() => subscribeToDataChanges((_type, changedHouseholdId) => {
    if (changedHouseholdId === householdId) void refresh();
  }), [householdId, refresh, subscribeToDataChanges]);

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await services.sync.startSync(householdId);
    } catch {
      // getStatus below reports the durable adapter error.
    } finally {
      setRetrying(false);
      await refresh();
    }
  };

  const lastSync = status.lastSyncedAt
    ? new Date(status.lastSyncedAt).toLocaleString(locale === 'fr' ? 'fr-CH' : 'en-CH', {
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : t('sync.never');

  return (
    <Card style={styles.card} testID="sync.statusCard">
      <Text variant="bodyBold">{t('sync.title')}</Text>
      {!available ? (
        <Text variant="caption" color={colors.textSecondary} style={styles.line}>
          {t('sync.localOnly')}
        </Text>
      ) : (
        <>
          <Text variant="caption" color={colors.textSecondary} style={styles.line}>
            {t('sync.lastSync', { date: lastSync })}
          </Text>
          <View style={styles.lines}>
            <Text variant="caption" color={status.isSyncing ? colors.primary : colors.textSecondary}>
              {status.isSyncing ? t('sync.inProgress') : t('sync.idle')}
            </Text>
            {status.pendingChanges > 0 && (
              <Text variant="caption" color={colors.warning}>
                {t('sync.pending', { count: status.pendingChanges })}
              </Text>
            )}
            {status.conflicts > 0 && (
              <Text variant="caption" color={colors.warning}>
                {t('sync.conflicts', { count: status.conflicts })}
              </Text>
            )}
            {status.error && (
              <Text variant="caption" color={colors.error}>
                {status.error}
              </Text>
            )}
          </View>
          <Button
            title={retrying || status.isSyncing ? t('sync.retrying') : t('sync.now')}
            variant="secondary"
            size="small"
            onPress={retry}
            disabled={retrying || status.isSyncing}
            loading={retrying}
            style={styles.button}
            testID="sync.retry"
          />
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: spacing.md,
  },
  line: {
    marginTop: spacing.xs,
  },
  lines: {
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  button: {
    marginTop: spacing.md,
    alignSelf: 'flex-start',
  },
});
