import { generateRecordId } from '../../src/infrastructure/repositories/recordIdentity';
import { DateTimeField } from '../../src/ui/components/DateTimeField';
import { CategoryPicker } from '../../src/features/entries/CategoryPicker';
import { PhotoField } from '../../src/features/entries/PhotoField';
import { todoNotificationId, RemindersDisabledError } from '../../src/infrastructure/local/LocalNotificationAdapter';
/**
 * ChoreScore V4 — À faire Tab
 *
 * To-do list. Free for all. No gating.
 *
 * V4-06 features:
 *   - Creation form lets an item be typed as a Tâche or a Dépense.
 *   - Completing a task confirms performer, value, beneficiaries and split,
 *     then atomically writes exactly one task ledger entry.
 *   - Completing an expense confirms amount, currency, payer, participants and
 *     split, then atomically writes exactly one expense ledger entry.
 *   - Optional note + photo on both kinds.
 *   - Delete todo (free, with confirmation).
 *   - Reminder via notification port (honest: no-op if unavailable).
 *   - Calendar event via calendar port (honest: no-op if unavailable).
 *   - Data-change signals for cross-tab refresh.
 *   - Optimistic local writes; offline-coherent atomic completion.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { ScreenContainer } from '../../src/ui/components/ScreenContainer';
import { Text } from '../../src/ui/components/Text';
import { Button } from '../../src/ui/components/Button';
import { Card } from '../../src/ui/components/Card';
import { colors, spacing, borderRadius } from '../../src/ui/design-system/theme';
import { useApp } from '../../src/features/app/AppContext';
import { useI18n } from '../../src/i18n';
import { formatCurrencyAmount, formatQuantity } from '../../src/presentation/balanceFormat';
import {
  Attachment,
  Category,
  ExpenseSplitMode,
  Household,
  Member,
  PersistentTask,
  TodoItem,
  TodoKind,
} from '../../src/domain/entities';
import { completeTodoAtomic } from '../../src/application/use-cases/completeTodoAtomic';
import {
  expenseSharesFromRaw,
  parseAmountToMinor,
  parsePositiveNumber,
  taskWeightsFromRaw,
} from '../../src/domain/services/addEntryService';

// ── Types ──────────────────────────────────────────────────────

type TodoView = 'list' | 'create' | 'complete';
type TodoTaskSplit = 'equal' | 'category' | 'custom';

interface CreateFormData {
  kind: TodoKind;
  title: string;
  assigneeMemberId: string | null;
  beneficiaryMemberIds: string[];
  dueAt: Date | null;
  reminderAt: Date | null;
  notes: string;
  persistentTaskId: string | null;
  categoryId: string | null;
  expenseAmountRaw: string;
  expenseCurrency: string;
}

interface CompleteFormData {
  performerMemberId: string;
  value: string;
  paidByMemberId: string;
  amountRaw: string;
  currency: string;
  beneficiaryMemberIds: string[];
  taskSplitChoice: TodoTaskSplit;
  taskWeightsRaw: Record<string, string>;
  expenseSplitMode: ExpenseSplitMode;
  customShares: Record<string, string>;
  note: string;
  attachments: Attachment[];
}

// ── Helpers ────────────────────────────────────────────────────

const DEFAULT_CURRENCY = 'CHF';

function formatDateShort(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** Render integer minor units back into a plain decimal string for the form. */
function amountMinorToRaw(amountMinor: number): string {
  const whole = Math.floor(amountMinor / 100);
  const cents = amountMinor % 100;
  return `${whole}.${cents.toString().padStart(2, '0')}`;
}

/** Keep a stored currency valid without throwing on a half-typed create form. */
function safeCurrency(currency: string): string {
  const normalized = currency.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : DEFAULT_CURRENCY;
}

// ── Component ──────────────────────────────────────────────────

export default function TodosScreen() {
  const { t, locale } = useI18n();
  const { currentHouseholdId, repos, currentUser, emitDataChange, subscribeToDataChanges, services } = useApp();

  const [categories, setCategories] = useState<Category[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [household, setHousehold] = useState<Household | null>(null);
  const [persistentTasks, setPersistentTasks] = useState<PersistentTask[]>([]);
  const [view, setView] = useState<TodoView>('list');
  const [selectedTodo, setSelectedTodo] = useState<TodoItem | null>(null);

  // Create form state
  const [createForm, setCreateForm] = useState<CreateFormData>({
    kind: 'task',
    title: '',
    assigneeMemberId: null,
    beneficiaryMemberIds: [],
    dueAt: null,
    reminderAt: null,
    notes: '',
    persistentTaskId: null,
    categoryId: null,
    expenseAmountRaw: '',
    expenseCurrency: DEFAULT_CURRENCY,
  });

  // Complete form state
  const [completeForm, setCompleteForm] = useState<CompleteFormData>({
    performerMemberId: '',
    value: '',
    paidByMemberId: '',
    amountRaw: '',
    currency: DEFAULT_CURRENCY,
    beneficiaryMemberIds: [],
    taskSplitChoice: 'equal',
    taskWeightsRaw: {},
    expenseSplitMode: 'equal',
    customShares: {},
    note: '',
    attachments: [],
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  // Synchronous guard: a rapid double-tap must never launch two completions
  // before React re-renders the disabled button.
  const submittingRef = useRef(false);

  // ── Load data ──────────────────────────────────────────────

  const loadData = useCallback(async () => {
    if (!currentHouseholdId) return;
    const [householdMembers, householdTodos, householdData, tasks, groupCategories] = await Promise.all([
      repos.members.getByHousehold(currentHouseholdId),
      repos.todos.getByHousehold(currentHouseholdId),
      repos.households.getById(currentHouseholdId),
      repos.tasks.getByHousehold(currentHouseholdId),
      repos.categories.getByHousehold(currentHouseholdId),
    ]);
    setLoadError(false);
    setMembers(householdMembers);
    setTodos(householdTodos.filter((todo) => todo.status !== 'completed'));
    setHousehold(householdData);
    setPersistentTasks(tasks);
    setCategories(groupCategories);

    // Set default members for create form
    if (householdMembers.length > 0) {
      setCreateForm((prev) => ({
        ...prev,
        assigneeMemberId: prev.assigneeMemberId || householdMembers[0].id,
        beneficiaryMemberIds:
          prev.beneficiaryMemberIds.length > 0
            ? prev.beneficiaryMemberIds
            : householdMembers.map((m) => m.id),
      }));
    }
  }, [currentHouseholdId, repos]);

  useEffect(() => {
    void loadData().catch(() => setLoadError(true));
  }, [loadData]);

  useEffect(() => subscribeToDataChanges(async (type, groupId) => {
    if (groupId !== currentHouseholdId || !['todo', 'member', 'household', 'category'].includes(type)) return;
    try { await loadData(); } catch { setLoadError(true); }
  }), [subscribeToDataChanges, currentHouseholdId, loadData]);

  // ── Create todo (task or expense) ──────────────────────────

  const handleCreate = async () => {
    if (submittingRef.current) return;
    if (!currentHouseholdId || !createForm.title.trim()) return;

    const kind = createForm.kind;
    let expenseAmountMinor: number | undefined;
    if (kind === 'expense' && createForm.expenseAmountRaw.trim()) {
      const parsed = parseAmountToMinor(createForm.expenseAmountRaw);
      if (parsed === null) {
        Alert.alert(t('state.error'), t('add.errorAmount'));
        return;
      }
      expenseAmountMinor = parsed;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      const created = await repos.withTransaction(async () => repos.todos.create({
        householdId: currentHouseholdId,
        title: createForm.title.trim(),
        assigneeMemberId: createForm.assigneeMemberId,
        beneficiaryMemberIds: createForm.beneficiaryMemberIds,
        dueAt: createForm.dueAt?.toISOString() || null,
        reminderAt: createForm.reminderAt?.toISOString() || null,
        notes: createForm.notes.trim(),
        persistentTaskId: kind === 'task' ? createForm.persistentTaskId : null,
        status: 'todo',
        kind,
        categoryId: createForm.categoryId,
        ...(kind === 'expense'
          ? {
              expenseAmountMinor,
              expenseCurrency: safeCurrency(createForm.expenseCurrency),
            }
          : {}),
      }));

      // A denied/failed reminder must not leave an unseen todo behind on retry.
      if (createForm.reminderAt) {
        try {
          await services.notifications.scheduleNotification({
            title: t('todos.reminderNotificationTitle', { title: createForm.title.trim() }),
            body: createForm.notes.trim() || t('todos.reminderNotificationBody'),
            scheduledAt: createForm.reminderAt.toISOString(),
            data: { todoId: created.id },
          });
        } catch (error) {
          await repos.withTransaction(async () => repos.todos.delete(created.id));
          throw error;
        }
      }

      // Create calendar event if due date is set and calendar port is available
      if (createForm.dueAt && services.calendar.isAvailable()) {
        const hasPermission = await services.calendar.requestPermission();
        if (hasPermission) {
          await services.calendar.createEvent({
            title: createForm.title.trim(),
            notes: createForm.notes.trim(),
            startDate: createForm.dueAt.toISOString(),
            endDate: new Date(createForm.dueAt.getTime() + 3600000).toISOString(),
          });
        }
      }

      // Reset form and go back to list
      resetCreateForm(kind);
      setView('list');
      await loadData();
      emitDataChange('todo', currentHouseholdId);
    } catch (error) {
      Alert.alert(t('state.error'), t(error instanceof RemindersDisabledError ? 'options.remindersDisabled' : 'todos.errorCreate'));
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const resetCreateForm = (kind: TodoKind = 'task') => {
    setCreateForm({
      kind,
      title: '',
      assigneeMemberId: members[0]?.id || null,
      beneficiaryMemberIds: members.map((m) => m.id),
      dueAt: null,
      reminderAt: null,
      notes: '',
      persistentTaskId: null,
      categoryId: null,
    expenseAmountRaw: '',
      expenseCurrency: DEFAULT_CURRENCY,
    });
  };

  // ── Start completion ───────────────────────────────────────

  const startComplete = (todo: TodoItem) => {
    const kind: TodoKind = todo.kind ?? 'task';
    const beneficiaryMemberIds =
      todo.beneficiaryMemberIds.length > 0
        ? todo.beneficiaryMemberIds
        : members.map((m) => m.id);
    setSelectedTodo(todo);
    setCompleteForm({
      performerMemberId: todo.assigneeMemberId || members[0]?.id || '',
      value: '',
      paidByMemberId: todo.assigneeMemberId || members[0]?.id || '',
      amountRaw:
        kind === 'expense' && todo.expenseAmountMinor !== undefined
          ? amountMinorToRaw(todo.expenseAmountMinor)
          : '',
      currency: todo.expenseCurrency || DEFAULT_CURRENCY,
      beneficiaryMemberIds,
      taskSplitChoice: categories.find(c => c.id === todo.categoryId)?.defaultTaskRatio ? 'category' : 'equal',
      taskWeightsRaw: {},
      expenseSplitMode: 'equal',
      customShares: {},
      note: todo.notes,
      attachments: [],
    });
    setView('complete');
  };

  // ── Derived completion values ──────────────────────────────

  const completeKind: TodoKind = selectedTodo?.kind ?? 'task';

  const taskWeightRaw = useMemo(() => {
    const raw: Record<string, string> = { ...completeForm.taskWeightsRaw };
    for (const id of completeForm.beneficiaryMemberIds) {
      if (raw[id] === undefined) raw[id] = '1';
    }
    return raw;
  }, [completeForm.taskWeightsRaw, completeForm.beneficiaryMemberIds]);

  const customTaskWeights = useMemo(
    () => taskWeightsFromRaw(completeForm.beneficiaryMemberIds, taskWeightRaw),
    [completeForm.beneficiaryMemberIds, taskWeightRaw],
  );

  const completeParsedAmountMinor = useMemo(
    () => parseAmountToMinor(completeForm.amountRaw),
    [completeForm.amountRaw],
  );

  const completeExpenseShares = useMemo(
    () => expenseSharesFromRaw(completeForm.beneficiaryMemberIds, completeForm.customShares),
    [completeForm.beneficiaryMemberIds, completeForm.customShares],
  );

  const completeExpenseTotal = useMemo(
    () => (completeExpenseShares ?? []).reduce((sum, share) => sum + share.amountMinor, 0),
    [completeExpenseShares],
  );

  const completeExpenseCustomValid =
    completeForm.expenseSplitMode !== 'custom' ||
    (completeExpenseShares !== null &&
      completeParsedAmountMinor !== null &&
      completeExpenseTotal === completeParsedAmountMinor);

  // ── Confirm completion (atomic) ────────────────────────────

  const handleComplete = async () => {
    if (submittingRef.current) return;
    if (!selectedTodo || !household || !currentUser) return;

    if (completeForm.beneficiaryMemberIds.length === 0) {
      Alert.alert(t('state.error'), t('todos.errorBeneficiary'));
      return;
    }

    if (completeKind === 'expense') {
      if (completeParsedAmountMinor === null) {
        Alert.alert(t('state.error'), t('add.errorAmount'));
        return;
      }
      if (completeForm.expenseSplitMode === 'custom' && !completeExpenseCustomValid) {
        Alert.alert(t('state.error'), t('add.errorSplit'));
        return;
      }

      submittingRef.current = true;
      setIsSubmitting(true);
      try {
        // Single atomic operation: todo status update + exactly one
        // ExpenseEntry commit together or roll back together. A retry after a
        // failure can never produce a second expense.
        await completeTodoAtomic(repos, {
          todo: selectedTodo,
          household,
          paidByMemberId: completeForm.paidByMemberId,
          amountMinor: completeParsedAmountMinor,
          currency: completeForm.currency,
          participantMemberIds: completeForm.beneficiaryMemberIds,
          completedByUserId: currentUser.userId,
          categoryId: categories.find(category => category.id === selectedTodo.categoryId)?.id ?? null,
          categoryLabelSnapshot: categories.find(c => c.id === selectedTodo.categoryId)?.name,
          customShares:
            completeForm.expenseSplitMode === 'custom' ? completeExpenseShares ?? undefined : undefined,
          note: completeForm.note,
          attachments: completeForm.attachments,
        });

        await services.notifications.cancelNotification(todoNotificationId(selectedTodo.id)).catch(() => undefined);
        emitDataChange('expense', currentHouseholdId!);
        emitDataChange('todo', currentHouseholdId!);
        setSelectedTodo(null);
        setView('list');
        await loadData();
      } catch {
        Alert.alert(t('state.error'), t('todos.errorComplete'));
      } finally {
        submittingRef.current = false;
        setIsSubmitting(false);
      }
      return;
    }

    const numericValue = parsePositiveNumber(completeForm.value);
    if (numericValue === null) {
      Alert.alert(t('state.error'), t('todos.errorValue'));
      return;
    }
    if (completeForm.taskSplitChoice === 'custom' && customTaskWeights === null) {
      Alert.alert(t('state.error'), t('add.taskSplitMissingWeight'));
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      // Single atomic operation: todo status update + exactly one task entry.
      await completeTodoAtomic(repos, {
        todo: selectedTodo,
        household,
        performerMemberId: completeForm.performerMemberId,
        value: numericValue,
        beneficiaryMemberIds: completeForm.beneficiaryMemberIds,
        completedByUserId: currentUser.userId,
        categoryId: categories.find(category => category.id === selectedTodo.categoryId)?.id ?? null,
        categoryLabelSnapshot: categories.find(c => c.id === selectedTodo.categoryId)?.name,
        category: completeForm.taskSplitChoice === 'category' ? categories.find(c => c.id === selectedTodo.categoryId) : null,
        overrideSplitWeights:
          completeForm.taskSplitChoice === 'custom' ? customTaskWeights : null,
        note: completeForm.note,
        attachments: completeForm.attachments,
      });

      await services.notifications.cancelNotification(todoNotificationId(selectedTodo.id)).catch(() => undefined);
      emitDataChange('contribution', currentHouseholdId!);
      emitDataChange('todo', currentHouseholdId!);
      setSelectedTodo(null);
      setView('list');
      await loadData();
    } catch {
      Alert.alert(t('state.error'), t('todos.errorComplete'));
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  // ── Delete todo ────────────────────────────────────────────

  const handleDelete = (todo: TodoItem) => {
    Alert.alert(t('add.deleteTitle'), t('todos.deleteConfirm', { title: todo.title }), [
      { text: t('action.cancel'), style: 'cancel' },
      {
        text: t('action.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            await repos.withTransaction(async () => repos.todos.delete(todo.id));
            setTodos((prev) => prev.filter((item) => item.id !== todo.id));
            emitDataChange('todo', currentHouseholdId!);
            // The todo deletion is already committed. A failed native cancel
            // must not leave it visible or prevent its tombstone being sent.
            await services.notifications.cancelNotification(todoNotificationId(todo.id)).catch(() => undefined);
          } catch {
            Alert.alert(t('state.error'), t('todos.errorDelete'));
          }
        },
      },
    ]);
  };

  // ── Photos ─────────────────────────────────────────────────

  const attachmentsAvailable = services.attachments.isAvailable();

  const addPhoto = async () => {
    if (!currentHouseholdId) return;
    try {
      const source = await services.attachments.pickPhoto();
      if (!source) return;
      const handle = await services.attachments.save(source, currentHouseholdId);
      setCompleteForm((prev) => ({
        ...prev,
        attachments: [
          ...prev.attachments,
          {
            id: generateRecordId('att'),
            kind: 'photo',
            ref: handle.ref,
            mimeType: handle.mimeType,
            byteSize: handle.byteSize,
            width: handle.width,
            height: handle.height,
            createdAt: new Date().toISOString(),
          },
        ],
      }));
    } catch {
      Alert.alert(t('state.error'), t('add.photoError'));
    }
  };

  const removePhoto = (id: string) => {
    setCompleteForm((prev) => ({
      ...prev,
      attachments: prev.attachments.filter((attachment) => attachment.id !== id),
    }));
  };

  // ── Helpers ────────────────────────────────────────────────

  const memberName = (memberId: string | null) => {
    if (!memberId) return t('todos.noAssignee');
    return members.find((m) => m.id === memberId)?.name || t('state.unknownMember');
  };

  const unitLabel =
    household?.contributionUnit === 'points' ? t('unit.pointsShort') : t('unit.minutesShort');

  const toggleCreateBeneficiary = (memberId: string) => {
    setCreateForm((prev) => {
      const ids = prev.beneficiaryMemberIds.includes(memberId)
        ? prev.beneficiaryMemberIds.filter((id) => id !== memberId)
        : [...prev.beneficiaryMemberIds, memberId];
      return { ...prev, beneficiaryMemberIds: ids };
    });
  };

  const toggleCompleteBeneficiary = (memberId: string) => {
    setCompleteForm((prev) => {
      const ids = prev.beneficiaryMemberIds.includes(memberId)
        ? prev.beneficiaryMemberIds.filter((id) => id !== memberId)
        : [...prev.beneficiaryMemberIds, memberId];
      return { ...prev, beneficiaryMemberIds: ids };
    });
  };

  const completeDisabled =
    isSubmitting ||
    completeForm.beneficiaryMemberIds.length === 0 ||
    (completeKind === 'expense'
      ? completeParsedAmountMinor === null ||
        (completeForm.expenseSplitMode === 'custom' && !completeExpenseCustomValid)
      : !completeForm.value ||
        parsePositiveNumber(completeForm.value) === null ||
        (completeForm.taskSplitChoice === 'custom' && customTaskWeights === null));

  // ── Render ─────────────────────────────────────────────────

  return (
    <ScreenContainer>
          {loadError ? <Card>
            <Text color={colors.error}>{t('state.error')}</Text>
            <Button title={t('action.retry')} onPress={() => { void loadData().catch(() => setLoadError(true)); }} />
          </Card> : null}
          {/* ── Header ────────────────────────────────────── */}
          <View style={styles.header}>
            <Text variant="screenTitle">{t('todos.title')}</Text>
          </View>

          {/* ── List View ─────────────────────────────────── */}
          {view === 'list' && (
            <>
              <View style={styles.actions}>
                <Button
                  testID="todos.newItem"
                  title={t('todos.newItem')}
                  variant="primary"
                  onPress={() => {
                    resetCreateForm('task');
                    setView('create');
                  }}
                />
              </View>

              {todos.length === 0 ? (
                <View style={styles.emptyState}>
                  <Text variant="sectionTitle" style={styles.emptyTitle}>
                    {t('todos.emptyTitle')}
                  </Text>
                  <Text variant="body" style={styles.emptyText}>
                    {t('todos.emptyBody')}
                  </Text>
                </View>
              ) : (
                <View style={styles.todoList}>
                  {todos.map((todo, index) => {
                    const kind: TodoKind = todo.kind ?? 'task';
                    return (
                      <Card key={todo.id} testID={`todos.item.${index}`} style={styles.todoCard}>
                        <View style={styles.todoRow}>
                          <View style={styles.todoInfo}>
                            <Text variant="caption" color={colors.textSecondary}>
                              {kind === 'expense' ? t('todos.kindExpense') : t('todos.kindTask')}
                            </Text>
                            <Text variant="bodyBold">{todo.title}</Text>
                            <Text variant="caption">
                              {memberName(todo.assigneeMemberId)}
                              {todo.dueAt
                                ? ` ${t('todos.dueLabel', { date: formatDateShort(todo.dueAt, locale) })}`
                                : ''}
                            </Text>
                            {kind === 'expense' && todo.expenseAmountMinor !== undefined ? (
                              <Text variant="caption" color={colors.textSecondary}>
                                {formatCurrencyAmount(
                                  todo.expenseAmountMinor,
                                  todo.expenseCurrency || DEFAULT_CURRENCY, locale,
                                )}
                              </Text>
                            ) : null}
                            {todo.notes ? (
                              <Text variant="caption" numberOfLines={1} style={styles.todoNotes}>
                                {todo.notes}
                              </Text>
                            ) : null}
                          </View>
                          <View style={styles.todoActions}>
                            <Button
                              testID={`todos.complete.${index}`}
                              title={t('todos.complete')}
                              variant="primary"
                              onPress={() => startComplete(todo)}
                              size="small"
                            />
                            <Button
                              testID={`todos.delete.${index}`}
                              title={t('action.deleteShort')}
                              variant="ghost"
                              onPress={() => handleDelete(todo)}
                              size="small"
                            />
                          </View>
                        </View>
                      </Card>
                    );
                  })}
                </View>
              )}
            </>
          )}

          {/* ── Create View ───────────────────────────────── */}
          {view === 'create' && (
            <Card style={styles.formCard} testID="todos.createForm">
              <View style={styles.inputGroup}>
                <Text variant="caption">{t('todos.titleLabel')}</Text>
                <TextInput
                  testID="todos.createTitle"
                  style={styles.input}
                  value={createForm.title}
                  onChangeText={(value) => setCreateForm((p) => ({ ...p, title: value }))}
                  placeholder={t('todos.titlePlaceholder')}
                  placeholderTextColor={colors.textMuted}
                />
              </View>

              {/* Kind: Tâche | Dépense */}
              <View style={styles.inputGroup}>
                <Text variant="caption">{t('todos.kind')}</Text>
                <View style={styles.splitRow}>
                  <TouchableOpacity
                    testID="todos.createKind.task"
                    style={[styles.splitButton, createForm.kind === 'task' && styles.splitButtonActive]}
                    onPress={() => setCreateForm((p) => ({ ...p, kind: 'task' }))}
                    accessibilityRole="button"
                    accessibilityState={{ selected: createForm.kind === 'task' }}
                  >
                    <Text
                      variant="caption"
                      color={createForm.kind === 'task' ? colors.textOnPrimary : colors.textSecondary}
                    >
                      {t('todos.kindTask')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    testID="todos.createKind.expense"
                    style={[styles.splitButton, createForm.kind === 'expense' && styles.splitButtonActive]}
                    onPress={() => setCreateForm((p) => ({ ...p, kind: 'expense' }))}
                    accessibilityRole="button"
                    accessibilityState={{ selected: createForm.kind === 'expense' }}
                  >
                    <Text
                      variant="caption"
                      color={createForm.kind === 'expense' ? colors.textOnPrimary : colors.textSecondary}
                    >
                      {t('todos.kindExpense')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* PersistentTask shortcuts (task only) */}
              {createForm.kind === 'task' && persistentTasks.length > 0 && (
                <View style={styles.inputGroup}>
                  <Text variant="caption">{t('add.shortcuts')}</Text>
                  <View style={styles.memberRow}>
                    {persistentTasks.map((pt) => (
                      <TouchableOpacity
                        key={pt.id}
                        style={[
                          styles.memberChip,
                          createForm.persistentTaskId === pt.id && styles.memberChipActive,
                        ]}
                        onPress={() => {
                          if (createForm.persistentTaskId === pt.id) {
                            setCreateForm((p) => ({ ...p, persistentTaskId: null }));
                          } else {
                            setCreateForm((p) => ({
                              ...p,
                              persistentTaskId: pt.id,
                              title: p.title || pt.name,
                            }));
                          }
                        }}
                      >
                        <Text
                          variant="caption"
                          color={
                            createForm.persistentTaskId === pt.id
                              ? colors.textOnPrimary
                              : colors.textSecondary
                          }
                        >
                          {pt.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}

              <CategoryPicker categories={categories} selectedId={createForm.categoryId}
                onSelect={categoryId => setCreateForm(p => ({ ...p, categoryId }))} />

              {/* Assignee / Payer */}
              <View style={styles.inputGroup}>
                <Text variant="caption">
                  {createForm.kind === 'expense' ? t('add.paidBy') : t('todos.assignee')}
                </Text>
                <View style={styles.memberRow}>
                  {members.map((m) => (
                    <TouchableOpacity
                      key={m.id}
                      style={[
                        styles.memberChip,
                        createForm.assigneeMemberId === m.id && styles.memberChipActive,
                      ]}
                      onPress={() => setCreateForm((p) => ({ ...p, assigneeMemberId: m.id }))}
                    >
                      <Text
                        variant="caption"
                        color={
                          createForm.assigneeMemberId === m.id
                            ? colors.textOnPrimary
                            : colors.textSecondary
                        }
                      >
                        {m.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Beneficiaries / Participants */}
              <View style={styles.inputGroup}>
                <Text variant="caption">
                  {createForm.kind === 'expense' ? t('add.participants') : t('todos.beneficiaries')}
                </Text>
                <View style={styles.memberRow}>
                  {members.map((m) => {
                    const selected = createForm.beneficiaryMemberIds.includes(m.id);
                    return (
                      <TouchableOpacity
                        key={m.id}
                        style={[styles.memberChip, selected && styles.memberChipActive]}
                        onPress={() => toggleCreateBeneficiary(m.id)}
                      >
                        <Text
                          variant="caption"
                          color={selected ? colors.textOnPrimary : colors.textSecondary}
                        >
                          {m.name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Expense amount + currency */}
              {createForm.kind === 'expense' && (
                <View style={styles.inputGroup}>
                  <Text variant="caption">{t('todos.plannedAmount')}</Text>
                  <View style={styles.amountRow}>
                    <TextInput
                      testID="todos.createAmount"
                      style={[styles.input, styles.amountInput]}
                      value={createForm.expenseAmountRaw}
                      onChangeText={(value) => setCreateForm((p) => ({ ...p, expenseAmountRaw: value }))}
                      placeholder="0.00"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="decimal-pad"
                    />
                    <TextInput
                      testID="todos.createCurrency"
                      style={[styles.input, styles.currencyInput]}
                      value={createForm.expenseCurrency}
                      onChangeText={(value) => setCreateForm((p) => ({ ...p, expenseCurrency: value }))}
                      placeholder={DEFAULT_CURRENCY}
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="characters"
                      maxLength={3}
                    />
                  </View>
                </View>
              )}

              <DateTimeField label={t('todos.due')} value={createForm.dueAt}
                emptyLabel={t('todos.noDue')} clearable testID="todos.dueDateTime"
                onChange={(dueAt) => setCreateForm(p => ({...p,dueAt}))} />

              <DateTimeField label={t('todos.reminder')} value={createForm.reminderAt}
                emptyLabel={t('todos.noReminder')} clearable testID="todos.reminderDateTime"
                onChange={(reminderAt) => setCreateForm(p => ({...p,reminderAt}))} />

              {/* Notes */}
              <View style={styles.inputGroup}>
                <Text variant="caption">{t('todos.notes')}</Text>
                <TextInput
                  testID="todos.createNotes"
                  style={styles.input}
                  value={createForm.notes}
                  onChangeText={(value) => setCreateForm((p) => ({ ...p, notes: value }))}
                  placeholder={t('todos.notesPlaceholder')}
                  placeholderTextColor={colors.textMuted}
                  multiline
                />
              </View>

              <View style={styles.createActions}>
                <Button
                  testID="todos.createSubmit"
                  title={t('action.create')}
                  variant="primary"
                  onPress={handleCreate}
                  disabled={!createForm.title.trim() || isSubmitting}
                  loading={isSubmitting}
                />
                <Button
                  title={t('action.cancel')}
                  variant="ghost"
                  onPress={() => {
                    setView('list');
                    resetCreateForm(createForm.kind);
                  }}
                  size="small"
                />
              </View>
            </Card>
          )}

          {/* ── Complete View (mini-form) ─────────────────── */}
          {view === 'complete' && selectedTodo && (
            <Card style={styles.formCard} testID="todos.completeForm">
              <View style={styles.editBanner}>
                <Text variant="sectionTitle">
                  {completeKind === 'expense'
                    ? t('todos.completeExpenseTitle')
                    : t('todos.completeTaskTitle')}
                </Text>
                <Button
                  title={t('action.cancel')}
                  variant="ghost"
                  size="small"
                  onPress={() => {
                    setSelectedTodo(null);
                    setView('list');
                  }}
                />
              </View>

              <Text variant="bodyBold" style={styles.completeTodoTitle}>
                {selectedTodo.title}
              </Text>

              {completeKind === 'expense' ? (
                <>
                  {/* Payer */}
                  <View style={styles.inputGroup}>
                    <Text variant="caption">{t('add.paidBy')}</Text>
                    <View style={styles.memberRow}>
                      {members.map((m) => (
                        <TouchableOpacity
                          key={m.id}
                          style={[
                            styles.memberChip,
                            completeForm.paidByMemberId === m.id && styles.memberChipActive,
                          ]}
                          onPress={() => setCompleteForm((p) => ({ ...p, paidByMemberId: m.id }))}
                        >
                          <Text
                            variant="caption"
                            color={
                              completeForm.paidByMemberId === m.id
                                ? colors.textOnPrimary
                                : colors.textSecondary
                            }
                          >
                            {m.name}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>

                  {/* Amount + currency confirmed at completion */}
                  <View style={styles.inputGroup}>
                    <Text variant="caption">{t('add.amount')}</Text>
                    <View style={styles.amountRow}>
                      <TextInput
                        testID="todos.completeAmount"
                        style={[styles.input, styles.amountInput]}
                        value={completeForm.amountRaw}
                        onChangeText={(value) => setCompleteForm((p) => ({ ...p, amountRaw: value }))}
                        placeholder="0.00"
                        placeholderTextColor={colors.textMuted}
                        keyboardType="decimal-pad"
                      />
                      <TextInput
                        testID="todos.completeCurrency"
                        style={[styles.input, styles.currencyInput]}
                        value={completeForm.currency}
                        onChangeText={(value) => setCompleteForm((p) => ({ ...p, currency: value }))}
                        placeholder={DEFAULT_CURRENCY}
                        placeholderTextColor={colors.textMuted}
                        autoCapitalize="characters"
                        maxLength={3}
                      />
                    </View>
                  </View>
                </>
              ) : (
                <>
                  {/* Performer */}
                  <View style={styles.inputGroup}>
                    <Text variant="caption">{t('todos.performedBy')}</Text>
                    <View style={styles.memberRow}>
                      {members.map((m) => (
                        <TouchableOpacity
                          key={m.id}
                          style={[
                            styles.memberChip,
                            completeForm.performerMemberId === m.id && styles.memberChipActive,
                          ]}
                          onPress={() =>
                            setCompleteForm((p) => ({ ...p, performerMemberId: m.id }))
                          }
                        >
                          <Text
                            variant="caption"
                            color={
                              completeForm.performerMemberId === m.id
                                ? colors.textOnPrimary
                                : colors.textSecondary
                            }
                          >
                            {m.name}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>

                  {/* Value */}
                  <View style={styles.inputGroup}>
                    <Text variant="caption">{t('todos.value', { unit: unitLabel })}</Text>
                    <TextInput
                      testID="todos.completeValue"
                      style={styles.input}
                      value={completeForm.value}
                      onChangeText={(value) => setCompleteForm((p) => ({ ...p, value }))}
                      placeholder={household?.contributionUnit === 'points' ? '3' : '15'}
                      placeholderTextColor={colors.textMuted}
                      keyboardType="numeric"
                    />
                  </View>
                </>
              )}

              {/* Beneficiaries / Participants */}
              <View style={styles.inputGroup}>
                <Text variant="caption">
                  {completeKind === 'expense' ? t('add.participants') : t('todos.beneficiaries')}
                </Text>
                <View style={styles.memberRow}>
                  {members.map((m) => {
                    const selected = completeForm.beneficiaryMemberIds.includes(m.id);
                    return (
                      <TouchableOpacity
                        key={m.id}
                        style={[styles.memberChip, selected && styles.memberChipActive]}
                        onPress={() => toggleCompleteBeneficiary(m.id)}
                      >
                        <Text
                          variant="caption"
                          color={selected ? colors.textOnPrimary : colors.textSecondary}
                        >
                          {m.name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {completeKind === 'task' && categories.find(c => c.id === selectedTodo?.categoryId)?.defaultTaskRatio &&
                <Button title={t('add.splitCategory')} variant={completeForm.taskSplitChoice === 'category' ? 'primary' : 'secondary'}
                  onPress={() => setCompleteForm(p => ({ ...p, taskSplitChoice: 'category' }))} />}
              {/* Split: equal or custom */}
              <View style={styles.inputGroup}>
                <Text variant="caption">{t('add.split')}</Text>
                <View style={styles.splitRow}>
                  <TouchableOpacity
                    style={[
                      styles.splitButton,
                      (completeKind === 'expense'
                        ? completeForm.expenseSplitMode === 'equal'
                        : completeForm.taskSplitChoice === 'equal') && styles.splitButtonActive,
                    ]}
                    onPress={() =>
                      setCompleteForm((p) =>
                        completeKind === 'expense'
                          ? { ...p, expenseSplitMode: 'equal' }
                          : { ...p, taskSplitChoice: 'equal' },
                      )
                    }
                  >
                    <Text
                      variant="caption"
                      color={
                        (completeKind === 'expense'
                          ? completeForm.expenseSplitMode === 'equal'
                          : completeForm.taskSplitChoice === 'equal')
                          ? colors.textOnPrimary
                          : colors.textSecondary
                      }
                    >
                      {t('add.splitEqual')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.splitButton,
                      (completeKind === 'expense'
                        ? completeForm.expenseSplitMode === 'custom'
                        : completeForm.taskSplitChoice === 'custom') && styles.splitButtonActive,
                    ]}
                    onPress={() =>
                      setCompleteForm((p) =>
                        completeKind === 'expense'
                          ? { ...p, expenseSplitMode: 'custom' }
                          : { ...p, taskSplitChoice: 'custom' },
                      )
                    }
                  >
                    <Text
                      variant="caption"
                      color={
                        (completeKind === 'expense'
                          ? completeForm.expenseSplitMode === 'custom'
                          : completeForm.taskSplitChoice === 'custom')
                          ? colors.textOnPrimary
                          : colors.textSecondary
                      }
                    >
                      {t('add.splitCustom')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Custom split details */}
              {completeKind === 'expense' && completeForm.expenseSplitMode === 'custom' && (
                <View style={styles.inputGroup}>
                  <Text variant="caption">{t('add.customShares')}</Text>
                  {completeForm.beneficiaryMemberIds.map((memberId) => (
                    <View key={memberId} style={styles.shareRow}>
                      <Text variant="body" style={styles.shareName}>
                        {memberName(memberId)}
                      </Text>
                      <TextInput
                        style={[styles.input, styles.shareInput]}
                        value={completeForm.customShares[memberId] || ''}
                        onChangeText={(value) =>
                          setCompleteForm((prev) => ({
                            ...prev,
                            customShares: { ...prev.customShares, [memberId]: value },
                          }))
                        }
                        placeholder="0.00"
                        placeholderTextColor={colors.textMuted}
                        keyboardType="decimal-pad"
                      />
                    </View>
                  ))}
                  {!completeExpenseCustomValid && completeParsedAmountMinor !== null && (
                    <Text variant="caption" color={colors.balanceNegative} style={styles.hint}>
                      {t('add.customSplitMismatch', {
                        shares: formatQuantity(completeExpenseTotal / 100, locale),
                        amount: formatQuantity(completeParsedAmountMinor / 100, locale),
                      })}
                    </Text>
                  )}
                </View>
              )}

              {completeKind === 'task' && completeForm.taskSplitChoice === 'custom' && (
                <View style={styles.inputGroup}>
                  <Text variant="caption">{t('add.weights')}</Text>
                  {completeForm.beneficiaryMemberIds.map((memberId) => (
                    <View key={memberId} style={styles.shareRow}>
                      <Text variant="body" style={styles.shareName}>
                        {memberName(memberId)}
                      </Text>
                      <TextInput
                        style={[styles.input, styles.shareInput]}
                        value={taskWeightRaw[memberId] ?? '1'}
                        onChangeText={(value) =>
                          setCompleteForm((prev) => ({
                            ...prev,
                            taskWeightsRaw: { ...prev.taskWeightsRaw, [memberId]: value },
                          }))
                        }
                        keyboardType="numeric"
                        placeholder="1"
                        placeholderTextColor={colors.textMuted}
                      />
                    </View>
                  ))}
                  {completeForm.beneficiaryMemberIds.length > 0 && customTaskWeights === null && (
                    <Text variant="caption" color={colors.balanceNegative} style={styles.hint}>
                      {t('add.taskSplitMissingWeight')}
                    </Text>
                  )}
                </View>
              )}

              {/* Note */}
              <View style={styles.inputGroup}>
                <Text variant="caption">{t('add.noteOptional')}</Text>
                <TextInput
                  testID="todos.completeNote"
                  style={styles.input}
                  value={completeForm.note}
                  onChangeText={(value) => setCompleteForm((p) => ({ ...p, note: value }))}
                  placeholder={t('add.notePlaceholder')}
                  placeholderTextColor={colors.textMuted}
                  multiline
                />
              </View>

              <PhotoField attachments={completeForm.attachments} available={attachmentsAvailable}
                onAdd={addPhoto} onRemove={removePhoto} testID="todos.completePhoto" />

              <Button
                testID="todos.completeSubmit"
                title={t('action.confirm')}
                variant="primary"
                onPress={handleComplete}
                disabled={completeDisabled}
                loading={isSubmitting}
                style={styles.submitButton}
              />
            </Card>
          )}
    </ScreenContainer>
  );
}

// ── Styles ─────────────────────────────────────────────────────

const styles = StyleSheet.create({
  header: {
    marginBottom: spacing.lg,
  },
  actions: {
    marginBottom: spacing.lg,
  },
  todoList: {
    gap: spacing.md,
  },
  todoCard: {
    marginBottom: spacing.sm,
  },
  todoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  todoInfo: {
    flex: 1,
    marginRight: spacing.md,
  },
  todoNotes: {
    marginTop: spacing.xs,
    color: colors.textMuted,
  },
  todoActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
  },
  emptyTitle: {
    marginBottom: spacing.md,
  },
  emptyText: {
    textAlign: 'center',
    color: colors.textSecondary,
  },
  formCard: {
    marginBottom: spacing.lg,
  },
  editBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  inputGroup: {
    marginBottom: spacing.md,
  },
  input: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    padding: spacing.md,
    marginTop: spacing.xs,
    fontSize: 16,
    color: colors.text,
  },
  amountRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  amountInput: {
    flex: 1,
  },
  currencyInput: {
    width: 70,
    textAlign: 'center',
  },
  memberRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  memberChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  memberChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  splitRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  splitButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  splitButtonActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  shareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  shareName: {
    flex: 1,
  },
  shareInput: {
    width: 80,
    textAlign: 'right',
    marginTop: 0,
  },
  dateTimeButton: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    padding: spacing.md,
    marginTop: spacing.xs,
  },
  createActions: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  completeTodoTitle: {
    marginBottom: spacing.md,
  },
  submitButton: {
    marginTop: spacing.sm,
  },
  hint: {
    marginTop: spacing.xs,
  },
  photoButton: {
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
  },
});
