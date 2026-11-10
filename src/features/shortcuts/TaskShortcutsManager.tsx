import React, { useLayoutEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { ContributionUnit, PersistentTask } from '../../domain/entities';
import { saveTaskShortcut, ShortcutValidationError } from '../../application/use-cases/taskShortcuts';
import { useApp } from '../app/AppContext';
import { useI18n } from '../../i18n';
import { Button } from '../../ui/components/Button';
import { Text } from '../../ui/components/Text';
import { spacing } from '../../ui/design-system/theme';

export function TaskShortcutsManager(props: {
  householdId: string; name: string; value: string; unit: ContributionUnit;
  beneficiaryMemberIds: string[]; tasks: PersistentTask[];
  onSaved: (task: PersistentTask) => void; onDeleted: (id: string) => void;
}) {
  const { repos, emitDataChange } = useApp();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const active = useRef<string | null>(props.householdId);
  useLayoutEffect(() => {
    active.current = props.householdId;
    setOpen(false);
    return () => { active.current = null; };
  }, [props.householdId]);
  const save = async () => {
    if (pending.current || active.current !== props.householdId) return;
    pending.current = true; setBusy(true);
    try {
      const task = await saveTaskShortcut(repos, props);
      emitDataChange('shortcut', props.householdId);
      if (active.current === props.householdId) props.onSaved(task);
    } catch (error) {
      if (active.current === props.householdId) Alert.alert(t('state.error'), t(error instanceof ShortcutValidationError ? 'shortcuts.invalid' : 'state.genericError'));
    } finally {
      pending.current = false;
      if (active.current !== null) setBusy(false);
    }
  };
  const remove = (task: PersistentTask) => Alert.alert(t('shortcuts.removeTitle'), t('shortcuts.removeBody'), [
    { text: t('action.cancel'), style: 'cancel' },
    { text: t('action.delete'), style: 'destructive', onPress: () => { void (async () => {
      if (pending.current || active.current !== props.householdId) return;
      pending.current = true; setBusy(true);
      try {
        await repos.tasks.delete(task.id);
        emitDataChange('shortcut', task.householdId);
        if (active.current === props.householdId) props.onDeleted(task.id);
      } catch {
        if (active.current === props.householdId) Alert.alert(t('state.error'), t('state.genericError'));
      } finally { pending.current = false; if (active.current !== null) setBusy(false); }
    })(); } },
  ]);
  return <View style={{ marginTop: spacing.sm }}>
    <Button title={t('shortcuts.manage')} variant="ghost" testID="shortcuts.manage" onPress={() => setOpen(value => !value)} />
    {open && <>
      <Text variant="caption">{t('shortcuts.help')}</Text>
      <Button title={t('shortcuts.save')} testID="shortcuts.save" variant="secondary" disabled={busy}
        onPress={save} loading={busy} />
      {props.tasks.map(task => <View key={task.id} style={{ marginTop: spacing.sm }}>
        <Text variant="body">{task.name} · {task.defaultValue} {t(task.defaultUnit === 'points' ? 'unit.pointsShort' : 'unit.minutesShort')}</Text>
        <Button title={t('action.delete')} accessibilityLabel={t('shortcuts.deleteNamed', { name: task.name })}
          testID={`shortcuts.delete.${task.id}`} variant="ghost" size="small" disabled={busy} onPress={() => remove(task)} />
      </View>)}
    </>}
  </View>;
}
