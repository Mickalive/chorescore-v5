import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../../ui/components/Text';
import { colors, spacing, borderRadius } from '../../ui/design-system/theme';
import { useI18n } from '../../i18n';
export function GroupsHeader({ groupCount, memberCount }: { groupCount: number; memberCount: number }) {
  const { t } = useI18n();
  return (
    <View style={styles.header}>
      <View style={styles.brand}><View style={styles.mark}><Text variant="bodyBold" color={colors.primaryDark}>CS</Text></View>
        <Text variant="caption">{t('app.name')}</Text></View>
      <Text variant="screenTitle">{t('groups.title')}</Text>
      <Text variant="body" color={colors.textSecondary}>{t('groups.subtitle')}</Text>
      <View style={styles.metrics}>
        <View style={styles.metric}><Text variant="metric">{groupCount}</Text><Text variant="caption">{t('groups.summaryGroups')}</Text></View>
        <View style={[styles.metric, styles.memberMetric]}><Text variant="metric">{memberCount}</Text><Text variant="caption">{t('groups.summaryMembers')}</Text></View>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  header: { gap: spacing.sm, marginBottom: spacing.xl },
  brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  mark: { width: 36, height: 36, borderRadius: 12, backgroundColor: colors.primaryLight, justifyContent: 'center', alignItems: 'center' },
  metrics: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
  metric: { flex: 1, padding: spacing.lg, borderRadius: borderRadius.md, backgroundColor: colors.surfaceHighlight, gap: spacing.xs },
  memberMetric: { backgroundColor: '#F8EDCB' },
});
