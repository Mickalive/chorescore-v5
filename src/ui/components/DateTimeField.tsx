import React, { useState } from 'react';
import { Modal, View, TextInput, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { Text } from './Text';
import { Button } from './Button';
import { colors, spacing, borderRadius } from '../design-system/theme';
import { useI18n } from '../../i18n';
import { localDateTimeParts, parseLocalDateTime } from '../../domain/services/localDateTime';

interface Props {
  label: string;
  value: Date | null;
  onChange: (value: Date | null) => void;
  emptyLabel?: string;
  clearable?: boolean;
  testID: string;
}

/** Drafts commit only on confirmation; cancel/back never changes the form.
 * ISO date fields are deliberately explicit, while the saved date is displayed
 * in the chosen language. The conversion uses the phone's local timezone. */
export function DateTimeField({ label, value, onChange, emptyLabel, clearable, testID }: Props) {
  const { t, locale } = useI18n();
  const [visible, setVisible] = useState(false);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [touched, setTouched] = useState(false);
  const parsed = parseLocalDateTime(date,time);
  const open = () => {
    const parts = localDateTimeParts(value ?? new Date());
    setDate(parts.date); setTime(parts.time); setTouched(false); setVisible(true);
  };
  const chooseNow = () => {
    const parts = localDateTimeParts(new Date());
    setDate(parts.date); setTime(parts.time); setTouched(false);
  };
  return <View style={styles.field}>
    <Text variant="caption">{label}</Text>
    <Button title={value ? new Intl.DateTimeFormat(locale, {dateStyle:'medium',timeStyle:'short'}).format(value) : emptyLabel ?? label}
      variant="secondary" onPress={open} testID={testID} accessibilityLabel={label} />
    <Modal visible={visible} transparent animationType="none" onRequestClose={() => setVisible(false)}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.center} keyboardShouldPersistTaps="handled">
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text variant="sectionTitle">{label}</Text>
            <Text variant="caption">{t('dateTime.localHint')}</Text>
            <Text variant="bodyBold">{t('dateTime.date')}</Text>
            <TextInput style={styles.input} value={date} onChangeText={setDate} onBlur={() => setTouched(true)}
              accessibilityLabel={t('dateTime.date')} placeholder="2026-10-22" autoCorrect={false}
              autoCapitalize="none" maxLength={10} testID={`${testID}.date`} />
            <Text variant="bodyBold">{t('dateTime.time')}</Text>
            <TextInput style={styles.input} value={time} onChangeText={setTime} onBlur={() => setTouched(true)}
              accessibilityLabel={t('dateTime.time')} placeholder="18:30" autoCorrect={false}
              autoCapitalize="none" maxLength={5} testID={`${testID}.time`} />
            {touched && !parsed ? <Text color={colors.error} accessibilityLiveRegion="polite">{t('dateTime.invalid')}</Text> : null}
            <Button title={t('dateTime.now')} variant="ghost" onPress={chooseNow} />
            <Button title={t('action.confirm')} disabled={!parsed} testID={`${testID}.confirm`}
              onPress={() => { if(parsed) { onChange(parsed); setVisible(false); } }} />
            {clearable && value ? <Button title={t('dateTime.clear')} variant="secondary"
              onPress={() => { onChange(null); setVisible(false); }} /> : null}
            <Button title={t('action.cancel')} variant="ghost" onPress={() => setVisible(false)} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  </View>;
}
const styles = StyleSheet.create({
  field:{gap:spacing.sm},overlay:{flex:1,backgroundColor:'rgba(20,40,48,0.45)'},
  center:{flexGrow:1,justifyContent:'center',alignItems:'center',padding:spacing.lg},
  dialog:{width:'100%',maxWidth:440,backgroundColor:colors.surface,borderRadius:borderRadius.lg,padding:spacing.xl,gap:spacing.md},
  input:{borderWidth:1,borderColor:colors.border,borderRadius:borderRadius.sm,minHeight:48,padding:spacing.md,fontSize:18,color:colors.text},
});
