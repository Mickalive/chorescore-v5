/**
 * ChoreScore V4 — Atomic Todo Completion Use-Case
 *
 * Executes the completion of a todo as ONE atomic operation:
 * the todo status update and exactly ONE ledger entry are written inside a
 * single storage-level transaction. If any write fails, the whole operation
 * rolls back: no orphan ledger entry, no silently completed todo without an
 * entry, and a retry can never produce a second entry.
 *
 *   kind 'task'    → todos.update + contributions.create  (V3, unchanged)
 *   kind 'expense' → todos.update + expenses.create
 *
 * Backend frugal §7: "Les changements couplés doivent employer
 * batch/transaction/opération métier atomique."
 */

import { AllRepositories } from '../../infrastructure/repositories/RepositoryFactory';
import {
  CompletionInput,
  CompletionOutput,
  ExpenseCompletionInput,
  ExpenseCompletionOutput,
  planTodoCompletion,
} from '../../domain/services/todoCompletionService';
import { todoCompletionEntryId } from '../../domain/services/todoCompletionId';

/**
 * Complete a todo atomically.
 *
 * The domain planning (`planTodoCompletion`) validates the input and
 * computes the pair (updated todo + ledger entry). The persistence then
 * runs inside `repos.withTransaction` so both writes commit together
 * or neither does.
 *
 * @throws if the todo is already completed, validation fails, or a write
 *         fails (in which case the transaction rolls back).
 */
export async function completeTodoAtomic(
  repos: AllRepositories,
  input: CompletionInput
): Promise<CompletionOutput>;
export async function completeTodoAtomic(
  repos: AllRepositories,
  input: ExpenseCompletionInput
): Promise<ExpenseCompletionOutput>;
export async function completeTodoAtomic(
  repos: AllRepositories,
  input: CompletionInput | ExpenseCompletionInput
): Promise<CompletionOutput | ExpenseCompletionOutput>;
export async function completeTodoAtomic(
  repos: AllRepositories,
  input: CompletionInput | ExpenseCompletionInput
): Promise<CompletionOutput | ExpenseCompletionOutput> {
  return repos.withTransaction(async () => {
    // Re-read under the transaction: the screen may still hold a stale todo
    // after another tap has completed it. Never trust that stale status.
    const todo = await repos.todos.getById(input.todo.id);
    if (!todo || todo.householdId !== input.household.id) {
      throw new Error('Todo does not belong to this household');
    }
    const result = planTodoCompletion({ ...input, todo });
    // Deterministic id shared with the server: a retry after an ambiguous
    // network result can never record the completion twice.
    const entryId = await todoCompletionEntryId(todo.id);
    if (result.kind === 'expense') {
      await repos.expenses.create({ ...result.expenseEntry, id: entryId } as Omit<
        typeof result.expenseEntry,
        'id'
      >);
    } else {
      await repos.contributions.create({ ...result.contributionEntry, id: entryId } as Omit<
        typeof result.contributionEntry,
        'id'
      >);
    }
    await repos.todos.update(todo.id, {
      status: 'completed',
      completedAt: result.updatedTodo.completedAt,
    });
    return result;
  });
}
