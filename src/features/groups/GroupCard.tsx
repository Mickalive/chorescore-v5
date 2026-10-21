import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Household } from '../../domain/entities';
import { Text } from '../../ui/components/Text';
import { colors, spacing, borderRadius } from '../../ui/design-system/theme';
import { useI18n } from '../../i18n';

export function GroupCard({ group, memberCount, onOpen, onOptions }: {
  group: Household; memberCount?: number; onOpen: () => void; onOptions: () => void;
}) {
  const { t } = useI18n();
  return (
    <View style={styles.card}>
      <TouchableOpacity onPress={onOpen} style={styles.open} accessibilityRole="button"
        accessibilityLabel={t('a11y.openGroup', { name: group.name })} testID={`groups.open.${group.id}`}>
        <View style={styles.avatar} accessibilityElementsHidden>
          <Text variant="sectionTitle" color={colors.primaryDark}>{group.name.trim().slice(0, 1).toLocaleUpperCase()}</Text>
        </View>
        <View style={styles.name}>
          <Text variant="sectionTitle">{group.name}</Text>
          <Text variant="caption">{t(group.contributionUnit === 'points' ? 'unit.points' : 'unit.minutes')}</Text>
        </View>
        <Text variant="sectionTitle" color={colors.primary} accessibilityElementsHidden>›</Text>
      </TouchableOpacity>
      <View style={styles.footer}>
        <Text variant="caption">{memberCount === undefined ? '…' : memberCount === 1
          ? t('groups.memberOne') : t('groups.memberMany', { count: memberCount })}</Text>
        <TouchableOpacity onPress={onOptions} style={styles.options} accessibilityRole="button"
          accessibilityLabel={t('a11y.groupOptions', { name: group.name })}>
          <Text variant="bodyBold" color={colors.primary}>{t('groups.options')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: borderRadius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  open: { padding: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 96 },
  name: { flex: 1, gap: spacing.xs },
  avatar: { height: 52, width: 52, borderRadius: 18, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingLeft: spacing.lg, paddingRight: spacing.sm, borderTopWidth: 1, borderTopColor: colors.divider,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surfaceAlt },
  options: { minHeight: 48, paddingHorizontal: spacing.md, justifyContent: 'center' },
});
