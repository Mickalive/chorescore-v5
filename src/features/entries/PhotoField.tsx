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
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const [failedLocalRefs, setFailedLocalRefs] = useState<Set<string>>(new Set());
  const [resolvedRefs, setResolvedRefs] = useState<Record<string, string>>({});
  const keyOf = (photo: Attachment): string =>
    JSON.stringify([currentHouseholdId, photo.id, photo.remoteRef ?? photo.ref]);
  const localSource = (photo: Attachment): string | null =>
    !failedLocalRefs.has(keyOf(photo)) && (!photo.remoteRef || /^(file|content):/.test(photo.ref))
      ? photo.ref : null;
  // A received photo only has a `media:` reference until the private file is
  // downloaded. Never hand that opaque reference to Image: on Android it fails
  // immediately and would strand the photo as "missing" even after download.
  const sourceOf = (photo: Attachment): string | null =>
    localSource(photo) ?? resolvedRefs[keyOf(photo)] ?? null;

  useEffect(() => { setPreview(null); }, [currentHouseholdId]);

  useEffect(() => {
    let cancelled = false;
    const remote = attachments.filter(
      (photo) => photo.remoteRef && !localSource(photo) && !resolvedRefs[keyOf(photo)] && !failedIds.has(keyOf(photo)),
    );
    if (!remote.length || !currentHouseholdId || !services.media.isAvailable()) return;
    void (async () => {
      const loaded: Record<string, string> = {};
      const failed: string[] = [];
      for (const photo of remote) {
        try {
          const uri = await services.media.download(currentHouseholdId, photo.remoteRef!);
          loaded[keyOf(photo)] = uri;
        } catch {
          failed.push(keyOf(photo));
        }
      }
      // Publish once per batch: publishing each photo used to cancel this
      // effect and start the remaining downloads again on every render.
      if (!cancelled) {
        if (Object.keys(loaded).length) setResolvedRefs(prev => ({ ...prev, ...loaded }));
        if (failed.length) setFailedIds(prev => new Set([...prev, ...failed]));
      }
    })();
    return () => { cancelled = true; };
  }, [attachments, currentHouseholdId, resolvedRefs, failedIds, failedLocalRefs, services.media]);

  return (
    <View style={styles.field}>
      <Text variant="caption">{t('add.photoOptional')}</Text>
      {attachments.map(photo => {
        const uri = sourceOf(photo);
        const key = keyOf(photo);
        const remotePending = Boolean(photo.remoteRef) && !uri;
        const failed = failedIds.has(key) || (remotePending && !services.media.isAvailable());
        return (
        <View key={photo.id} style={styles.row}>
          <TouchableOpacity onPress={() => setPreview(photo)} accessibilityRole="button"
            accessibilityLabel={t('photo.openPreview')} style={styles.thumbnailButton}
            disabled={failed} accessibilityState={{ disabled: failed }}>
            {failed ? <Text variant="caption">{t('add.photoMissing')}</Text>
              : uri ? <Image source={{ uri }} style={styles.thumbnail}
                resizeMode="cover" onError={() => {
                  if (localSource(photo) && photo.remoteRef) {
                    setFailedLocalRefs(prev => new Set([...prev, key]));
                  } else setFailedIds(prev => new Set([...prev, key]));
                }} />
              : <Text variant="caption" color={colors.textMuted}>{t('state.loading')}</Text>}
          </TouchableOpacity>
          <Text variant="caption" style={styles.label}>{t('add.photoAttached')}</Text>
          {failed && photo.remoteRef && services.media.isAvailable() ?
            <Button title={t('action.retry')} variant="secondary" size="small" onPress={() => {
              setFailedIds(prev => { const next = new Set(prev); next.delete(key); return next; });
              setResolvedRefs(prev => { const next = { ...prev }; delete next[key]; return next; });
            }} /> : null}
          <Button title={t('add.photoRemove')} variant="ghost" size="small" onPress={() => onRemove(photo.id)} />
        </View>
        );
      })}
      {available ? <Button title={t('add.photoAdd')} variant="secondary" size="small" onPress={onAdd} testID={testID} />
        : <Text variant="caption" color={colors.textMuted}>{t('add.photoUnavailable')}</Text>}
      <Modal visible={!!preview} animationType="fade" onRequestClose={() => setPreview(null)}>
        <SafeAreaView style={styles.preview}>
          <View style={styles.close}><Button title={t('action.close')} variant="secondary" onPress={() => setPreview(null)} /></View>
          {preview && sourceOf(preview) && (
            <Image source={{ uri: sourceOf(preview)! }} style={styles.fullImage} resizeMode="contain" accessibilityLabel={t('add.photoAttached')} />
          )}
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
