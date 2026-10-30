import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Category } from '../../domain/entities';
import { Text } from '../../ui/components/Text';
import { colors, spacing, borderRadius } from '../../ui/design-system/theme';
import { useI18n } from '../../i18n';
export function CategoryPicker({ categories, selectedId, onSelect }: {
  categories: Category[]; selectedId: string | null; onSelect: (id: string | null) => void;
}) {
  const { t } = useI18n();
  return <View style={styles.field}><Text variant="caption">{t('add.category')}</Text>
    <View style={styles.row}>{[{ id: null, name: t('add.categoryNone') }, ...categories].map(option => {
      const selected = selectedId === option.id;
      return <TouchableOpacity key={option.id ?? 'none'} onPress={() => onSelect(option.id)}
        accessibilityRole="radio" accessibilityState={{ checked: selected }} accessibilityLabel={option.name}
        style={[styles.chip, selected && styles.selected]}>
        <Text variant="caption" color={selected ? colors.textOnPrimary : colors.textSecondary}>{option.name}</Text>
      </TouchableOpacity>;
    })}</View>
  </View>;
}
const styles = StyleSheet.create({
  field: { marginBottom: spacing.lg, gap: spacing.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.md,
    borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.sm },
  selected: { backgroundColor: colors.primary, borderColor: colors.primary },
});
