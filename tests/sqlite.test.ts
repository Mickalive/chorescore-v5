/** Actual disk-backed SQLite through Node's driver. Only the native bridge is
 * substituted; schema, SQL repositories, transactions and use cases are real.
 * This does not validate the Expo Android bridge or device UI.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase, initializeSchema, applyV4ColumnMigrations } from '../src/infrastructure/local/SqliteStorage';
import { createSqliteRepositories } from '../src/infrastructure/repositories/RepositoryFactory';
import { createGroupWithMembers } from '../src/application/use-cases/groupMembers';
import { completeTodoAtomic } from '../src/application/use-cases/completeTodoAtomic';

let mockDatabase: any;
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: async () => mockDatabase }));

const sqlite = (process as any).getBuiltinModule('node:sqlite');
const folder = mkdtempSync(join(tmpdir(), 'chorescore-sqlite-'));
const path = join(folder, 'data.db');
let native: any;
function open() {
  native = new sqlite.DatabaseSync(path);
  mockDatabase = {
    execAsync: async (sql: string) => native.exec(sql),
    runAsync: async (sql: string, ...args: any[]) => native.prepare(sql).run(...(Array.isArray(args[0]) ? args[0] : args)),
    getAllAsync: async (sql: string, ...args: any[]) => native.prepare(sql).all(...(Array.isArray(args[0]) ? args[0] : args)),
    getFirstAsync: async (sql: string, ...args: any[]) => native.prepare(sql).get(...(Array.isArray(args[0]) ? args[0] : args)) ?? null,
    closeAsync: async () => native.close(),
    withTransactionAsync: async (fn: () => Promise<void>) => {
      native.exec('BEGIN');
      try { await fn(); native.exec('COMMIT'); }
      catch (error) { native.exec('ROLLBACK'); throw error; }
    },
  };
}
// getDatabase retains the bridge object, so keep its methods pointing at the
// current driver when closing/reopening the same database file.
afterAll(() => { native.close(); rmSync(folder, { recursive: true }); });

test('real SQLite: task + expense completion is unique, rollback-safe and durable after reopen', async () => {
  open();
  await getDatabase();
  const repos = (await createSqliteRepositories())!;
  expect(repos).not.toBeNull();
  const { household, ownerMember, namedMembers } = await createGroupWithMembers(repos, {
    name: 'Foyer', owner: { userId: 'a', displayName: 'Alice' }, memberNames: ['Bob'], contributionUnit: 'points',
  });
  const ids = [ownerMember.id, namedMembers[0].id];
  for (const kind of ['task', 'expense'] as const) {
    const todo = await repos.todos.create({ householdId: household.id, title: kind, kind,
      status: 'todo', assigneeMemberId: ids[0], beneficiaryMemberIds: ids,
      dueAt: null, reminderAt: null, notes: 'Persistante', persistentTaskId: null });
    const common = { todo, household, completedByUserId: 'a' };
    const input = kind === 'task'
      ? { ...common, performerMemberId: ids[0], beneficiaryMemberIds: ids, value: 12 }
      : { ...common, paidByMemberId: ids[0], participantMemberIds: ids, amountMinor: 101, currency: 'EUR' };
    const failed = jest.spyOn(repos.todos, 'update').mockRejectedValueOnce(new Error('disk failure'));
    await expect(completeTodoAtomic(repos, input)).rejects.toThrow('disk failure');
    expect((await repos.todos.getById(todo.id))?.status).toBe('todo');
    expect(await repos.syncState.getDirtyRecords(household.id,
      kind === 'task' ? 'contribution_entries' : 'expense_entries', 0)).toHaveLength(0);
    failed.mockRestore();
    const result = await Promise.allSettled([completeTodoAtomic(repos, input), completeTodoAtomic(repos, input)]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  }
  native.close();
  native = new sqlite.DatabaseSync(path);
  expect(await repos.contributions.getByHousehold(household.id)).toEqual([
    expect.objectContaining({ unit: 'points', value: 12, note: 'Persistante' }),
  ]);
  const expenses = await repos.expenses.getByHousehold(household.id);
  expect(expenses).toHaveLength(1);
  expect(expenses[0]).toMatchObject({ amountMinor: 101, currency: 'EUR', note: 'Persistante' });
  expect(await repos.todos.getByHousehold(household.id)).toEqual([
    expect.objectContaining({ status: 'completed' }), expect.objectContaining({ status: 'completed' }),
  ]);
  await initializeSchema(mockDatabase);
  expect(await applyV4ColumnMigrations(mockDatabase)).toBe(0);
  expect((await repos.households.getById(household.id))?.contributionUnit).toBe('points');
});

test('photo references follow committed edits/deletions and survive rollback or shared references', async () => {
  const repos = (await createSqliteRepositories())!;
  const group = (await repos.households.getAll())[0];
  const members = await repos.members.getByHousehold(group.id);
  const ref = 'file:///private/chorescore-photos/test/photo.jpg';
  const attachments = [{ id: 'photo', kind: 'photo' as const, ref, createdAt: new Date().toISOString() }];
  const make = () => repos.expenses.create({ householdId: group.id, title: 'Photo', amountMinor: 100,
    currency: 'EUR', paidByMemberId: members[0].id, participantMemberIds: members.map(m => m.id),
    splitMode: 'equal', attachments, occurredAt: new Date().toISOString(), createdBy: 'a' });
  const one = await make(), two = await make();
  const count = () => mockDatabase.getFirstAsync('SELECT COUNT(*) AS n FROM attachment_links WHERE ref = ?', [ref]);
  expect((await count()).n).toBe(2);
  await expect(repos.withTransaction(async () => {
    await repos.expenses.update(one.id, { attachments: [] });
    throw new Error('cancel');
  })).rejects.toThrow('cancel');
  expect((await count()).n).toBe(2);
  await repos.expenses.delete(one.id);
  expect((await count()).n).toBe(1);
  await repos.expenses.update(two.id, { attachments: [] });
  expect((await count()).n).toBe(0);
  expect(await mockDatabase.getAllAsync(`SELECT f.ref FROM attachment_files f
    WHERE f.committed = 1 AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.ref = f.ref)`)).toEqual([{ ref }]);
});

test('outbox sequences are unique across concurrent reservations and process restart', async () => {
  const repos = (await createSqliteRepositories())!;
  const values = await Promise.all(Array.from({ length: 20 }, () => repos.syncState.nextLocalRevision('g', 'members')));
  expect(new Set(values).size).toBe(20);
  native.close(); native = new sqlite.DatabaseSync(path);
  const reopened = (await createSqliteRepositories())!;
  expect(await reopened.syncState.nextLocalRevision('g', 'members')).toBeGreaterThan(Math.max(...values));
});
