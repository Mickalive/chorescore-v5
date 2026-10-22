import React, { useRef, useState } from 'react';
import { Alert, Modal, StyleSheet, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Household } from '../../domain/entities';
import { useApp } from '../app/AppContext';
import { useI18n } from '../../i18n';
import { Card } from '../../ui/components/Card';
import { Button } from '../../ui/components/Button';
import { Text } from '../../ui/components/Text';
import { ScreenContainer } from '../../ui/components/ScreenContainer';
import { colors, spacing, borderRadius } from '../../ui/design-system/theme';
import { todoNotificationId } from '../../infrastructure/local/LocalNotificationAdapter';

export function DeleteGroupCard({household}: {household: Household}) {
  const {t} = useI18n(); const router = useRouter();
  const {currentUser,repos,services,loadHouseholds,setCurrentHouseholdId,emitDataChange} = useApp();
  const [visible,setVisible] = useState(false); const [name,setName] = useState('');
  const [busy,setBusy] = useState(false); const active = useRef(false);
  if (household.ownerId !== currentUser?.userId) return null;
  const remove = async () => {
    if (active.current || name !== household.name) return;
    active.current = true; setBusy(true);
    let removed = false;
    try {
      const todos = await repos.todos.getByHousehold(household.id);
      await repos.withTransaction(() => repos.households.delete(household.id));
      removed = true;
      let remindersFailed = false;
      for (const todo of todos) {
        try { await services.notifications.cancelNotification(todoNotificationId(todo.id)); }
        catch { remindersFailed = true; }
      }
      setCurrentHouseholdId(null); await loadHouseholds();
      emitDataChange('household',household.id);
      setVisible(false); router.replace('/');
      if (remindersFailed) Alert.alert(t('state.error'),t('groupDelete.reminderError'));
    } catch {
      if (removed) { setCurrentHouseholdId(null); setVisible(false); router.replace('/'); }
      Alert.alert(t('state.error'),t(removed ? 'groupDelete.refreshError' : 'groupDelete.error'));
    }
    finally { active.current = false; setBusy(false); }
  };
  return <Card style={styles.card}>
    <Text variant="bodyBold" color={colors.error}>{t('groupDelete.title')}</Text>
    <Text variant="caption">{t('groupDelete.warning')}</Text>
    <Button title={t('groupDelete.title')} variant="secondary" testID="group.deleteOpen"
      onPress={() => {setName('');setVisible(true);}} />
    <Modal visible={visible} animationType="none" onRequestClose={() => {if(!busy)setVisible(false);}}>
      <ScreenContainer scrollable>
        <View style={styles.content}>
          <Text variant="sectionTitle">{t('groupDelete.title')}</Text>
          <Text>{t('groupDelete.warning')}</Text>
          <Text>{t('groupDelete.typeName',{name:household.name})}</Text>
          <TextInput value={name} onChangeText={setName} style={styles.input} testID="group.deleteName"
            accessibilityLabel={t('groupDelete.name')} autoCorrect={false} editable={!busy} />
          <Button title={t('groupDelete.confirm')} onPress={remove} disabled={name !== household.name || busy}
            loading={busy} style={{backgroundColor:colors.error}} testID="group.deleteConfirm" />
          <Button title={t('action.cancel')} variant="ghost" disabled={busy} onPress={() => setVisible(false)} />
        </View>
      </ScreenContainer>
    </Modal>
  </Card>;
}
const styles = StyleSheet.create({card:{gap:spacing.md,marginBottom:spacing.lg},content:{gap:spacing.lg,paddingTop:spacing.xl},
  input:{minHeight:48,borderWidth:1,borderColor:colors.border,borderRadius:borderRadius.sm,padding:spacing.md,color:colors.text,fontSize:16}});
