import React, { useEffect, useState } from 'react';
import { Image, Modal, StyleSheet, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Attachment } from '../../domain/entities';
import { Text } from '../../ui/components/Text';
import { Button } from '../../ui/components/Button';
import { colors, spacing, borderRadius } from '../../ui/design-system/theme';
import { useI18n } from '../../i18n';
import { useApp } from '../app/AppContext';

export function PhotoField({ attachments, available, onAdd, onRemove, testID }: {
  attachments: Attachment[]; available: boolean; onAdd: () => void;
  onRemove: (id: string) => void; testID?: string;
}) {
  const { t } = useI18n();
  const { services, currentHouseholdId } = useApp();
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [failedRefs, setFailedRefs] = useState<Set<string>>(new Set());
  const [resolvedRefs, setResolvedRefs] = useState<Record<string, string>>({});
  const sourceOf = (photo: Attachment) => resolvedRefs[photo.id] ?? photo.ref;

  useEffect(() => {
    let cancelled = false;
    const remote = attachments.filter(
      (photo) => photo.remoteRef && photo.ref.startsWith('media:') && !resolvedRefs[photo.id],
    );
    if (!remote.length || !currentHouseholdId || !services.media.isAvailable()) return;
    void (async () => {
      for (const photo of remote) {
        try {
          const uri = await services.media.download(currentHouseholdId, photo.remoteRef!);
          if (!cancelled) setResolvedRefs((prev) => ({ ...prev, [photo.id]: uri }));
        } catch {
          if (!cancelled) setFailedRefs((prev) => new Set([...prev, photo.ref]));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [attachments, currentHouseholdId, resolvedRefs, services.media]);

  return (
    <View style={styles.field}>
      <Text variant="caption">{t('add.photoOptional')}</Text>
      {attachments.map(photo => (
        <View key={photo.id} style={styles.row}>
          <TouchableOpacity onPress={() => setPreview(photo)} accessibilityRole="button"
            accessibilityLabel={t('photo.openPreview')} style={styles.thumbnailButton}
            disabled={failedRefs.has(photo.ref)} accessibilityState={{ disabled: failedRefs.has(photo.ref) }}>
            {!failedRefs.has(photo.ref) ? <Image source={{ uri: sourceOf(photo) }} style={styles.thumbnail}
              resizeMode="cover" onError={() => setFailedRefs(prev => new Set([...prev, photo.ref]))} />
              : <Text variant="caption">{t('add.photoMissing')}</Text>}
          </TouchableOpacity>
          <Text variant="caption" style={styles.label}>{t('add.photoAttached')}</Text>
          <Button title={t('add.photoRemove')} variant="ghost" size="small" onPress={() => onRemove(photo.id)} />
        </View>
      ))}
      {available ? <Button title={t('add.photoAdd')} variant="secondary" size="small" onPress={onAdd} testID={testID} />
        : <Text variant="caption" color={colors.textMuted}>{t('add.photoUnavailable')}</Text>}
      <Modal visible={!!preview} animationType="fade" onRequestClose={() => setPreview(null)}>
        <SafeAreaView style={styles.preview}>
          <View style={styles.close}><Button title={t('action.close')} variant="secondary" onPress={() => setPreview(null)} /></View>
          {preview && <Image source={{ uri: sourceOf(preview) }} style={styles.fullImage} resizeMode="contain" accessibilityLabel={t('add.photoAttached')} />}
        </SafeAreaView>
      </Modal>
    </View>
  );
}
const styles = StyleSheet.create({
  field: { gap: spacing.sm, marginBottom: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  label: { flex: 1, minWidth: 72 },
  thumbnailButton: { minWidth: 72, minHeight: 72, justifyContent: 'center' },
  thumbnail: { width: 72, height: 72, borderRadius: borderRadius.sm },
  preview: { flex: 1, backgroundColor: colors.text },
  close: { alignItems: 'flex-end', padding: spacing.lg },
  fullImage: { flex: 1, width: '100%' },
});
