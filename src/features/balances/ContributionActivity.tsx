import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { ContributionUnit, Member } from '../../domain/entities';
import { ContributionActivityTotal } from '../../domain/calculations/contributionActivity';
import { Period } from '../../domain/calculations/periods';
import { useApp } from '../app/AppContext';
import { useI18n } from '../../i18n';
import { Card } from '../../ui/components/Card';
import { Text } from '../../ui/components/Text';
import { Button } from '../../ui/components/Button';
import { colors, spacing } from '../../ui/design-system/theme';
import { formatContributionValue } from '../../presentation/balanceFormat';

/** Activity is what was performed, distinct from the zero-sum balance owed.
 * Names remain in group order; bars are not a ranking or an identity colour.
 */
export function ContributionActivity(props: {
  householdId: string; unit: ContributionUnit; members: Member[]; period: Period;
  persistentTaskId?: string | null; revision: unknown;
}) {
  const { repos } = useApp();
  const { t, locale } = useI18n();
  const [unit, setUnit] = useState(props.unit);
  const [rows, setRows] = useState<ContributionActivityTotal[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  const request = useRef(0);
  const queryKey = JSON.stringify([props.householdId,unit,props.period,props.persistentTaskId]);
  const [resultKey, setResultKey] = useState<string | null>(null);
  useLayoutEffect(() => { setUnit(props.unit); }, [props.householdId, props.unit]);
  useEffect(() => {
    const id = ++request.current;
    setLoading(true); setError(false); setRows([]);
    repos.contributions.getActivitySummary(props.householdId, { unit, period: props.period, persistentTaskId: props.persistentTaskId })
      .then(result => { if (id === request.current) { setRows(result); setResultKey(queryKey); } })
      .catch(() => { if (id === request.current) { setError(true); setResultKey(queryKey); } })
      .finally(() => { if (id === request.current) setLoading(false); });
    return () => { request.current += 1; };
  }, [repos,props.householdId,props.period,props.persistentTaskId,props.revision,unit,retry,queryKey]);
  const total = rows.reduce((sum,row) => sum+row.value,0);
  const count = rows.reduce((sum,row) => sum+row.count,0);
  const unitLabel = t(unit === 'minutes' ? 'unit.minutesShort' : 'unit.pointsShort');
  return <Card testID="activity.summary" style={{ marginBottom: spacing.lg }}>
    <Text variant="sectionTitle">{t('activity.title')}</Text>
    <Text variant="caption">{t('activity.help')}</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginVertical: spacing.sm }}>
      {(['minutes','points'] as const).map(value => <Button key={value} testID={`activity.unit.${value}`}
        title={t(value === 'minutes' ? 'unit.minutes' : 'unit.points')} variant={unit === value ? 'primary' : 'ghost'}
        onPress={() => setUnit(value)} />)}
    </View>
    {loading || resultKey !== queryKey ? <Text variant="caption">{t('state.loading')}</Text> : error ? <>
      <View accessibilityRole="alert"><Text variant="body">{t('activity.error')}</Text></View>
      <Button title={t('action.retry')} onPress={() => setRetry(value => value+1)} />
    </> : <>
      <Text variant="bodyBold" testID="activity.total">{formatContributionValue(total,unitLabel,locale)} · {t(count === 1 ? 'activity.countOne' : 'activity.countMany', { count })}</Text>
      {props.members.map(member => {
        const row = rows.find(item => item.memberId === member.id);
        const value = row?.value ?? 0;
        const percent = total > 0 ? Math.max(0,Math.min(100,value/total*100)) : 0;
        return <View key={member.id} style={{ marginTop: spacing.md }}>
          <Text variant="body">{member.name} · {formatContributionValue(value,unitLabel,locale)} · {Math.round(percent)} %</Text>
          <View accessible accessibilityRole="progressbar" accessibilityLabel={member.name}
            accessibilityValue={{ min: 0,max: 100,now: percent,text: formatContributionValue(value,unitLabel,locale) }}
            style={{ marginTop: spacing.xs,height: 8,backgroundColor: colors.border,borderRadius: 4 }}>
            <View style={{ width: `${percent}%`,height: 8,backgroundColor: colors.primary,borderRadius: 4 }} />
          </View>
        </View>;
      })}
    </>}
  </Card>;
}
