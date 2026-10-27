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
  const unicodeTodo = await repos.todos.create({ householdId: household.id,
    title: 'Payer l\u2019électricité – tâche café', kind: 'task', status: 'todo',
    assigneeMemberId: ids[0], beneficiaryMemberIds: ids, dueAt: null, reminderAt: null,
    notes: 'Dépôt à l\u2019agence nº 4', persistentTaskId: null });
  native.close();
  native = new sqlite.DatabaseSync(path);
  expect(await repos.todos.getById(unicodeTodo.id)).toMatchObject({
    title: 'Payer l\u2019électricité – tâche café',
    notes: 'Dépôt à l\u2019agence nº 4',
  });
  expect(await repos.contributions.getByHousehold(household.id)).toEqual([
    expect.objectContaining({ unit: 'points', value: 12, note: 'Persistante' }),
  ]);
  const expenses = await repos.expenses.getByHousehold(household.id);
  expect(expenses).toHaveLength(1);
  expect(expenses[0]).toMatchObject({ amountMinor: 101, currency: 'EUR', note: 'Persistante' });
  const persistedTodos = await repos.todos.getByHousehold(household.id);
  expect(persistedTodos).toHaveLength(3);
  expect(persistedTodos).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 'completed' }),
    expect.objectContaining({ status: 'todo', title: 'Payer l\u2019électricité – tâche café' }),
  ]));
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

test('entry mutation and local outbox commit together when the sync write fails', async () => {
  const repos = (await createSqliteRepositories())!;
  const group = (await repos.households.getAll())[0];
  const members = await repos.members.getByHousehold(group.id);
  const before = await repos.contributions.getByHousehold(group.id);
  const originalRun = mockDatabase.runAsync;
  const failure = jest.spyOn(mockDatabase, 'runAsync').mockImplementation(async (sql: unknown, ...args: any[]) => {
    if (typeof sql === 'string' && /INSERT.*sync_records/i.test(sql)) throw new Error('outbox disk failure');
    return originalRun(sql,...args);
  });
  try {
    await expect(repos.withTransaction(() => repos.contributions.create({
      householdId:group.id,persistentTaskId:null,label:'Must roll back',performedByMemberId:members[0].id,
      beneficiaryMemberIds:members.map(m => m.id),value:7,unit:'points',occurredAt:new Date().toISOString(),createdBy:'a',
    }))).rejects.toThrow('outbox disk failure');
  } finally { failure.mockRestore(); }
  expect(await repos.contributions.getByHousehold(group.id)).toEqual(before);
  // The rolled-back reservation must not poison the transaction queue.
  await repos.withTransaction(() => repos.contributions.create({
    householdId:group.id,persistentTaskId:null,label:'Retry succeeds',performedByMemberId:members[0].id,
    beneficiaryMemberIds:members.map(m => m.id),value:7,unit:'points',occurredAt:new Date().toISOString(),createdBy:'a',
  }));
  expect((await repos.contributions.getByHousehold(group.id)).length).toBe(before.length+1);
});

test('group deletion is isolated, owner-only, rollback-safe and clears private rows and links', async () => {
  const { createScopedRepositories } = await import('../src/infrastructure/repositories/ScopedRepositoryFacade');
  const raw = (await createSqliteRepositories())!;
  const {household,ownerMember,namedMembers} = await createGroupWithMembers(raw,{
    name:'Delete test',owner:{userId:'delete-owner',displayName:'Owner'},memberNames:['Member'],contributionUnit:'minutes',
  });
  await raw.memberships.create({userId:'delete-member',householdId:household.id,role:'MEMBER'});
  const attachment = {id:'delete-photo',kind:'photo' as const,ref:'file:///private/chorescore-photos/delete/photo.jpg',createdAt:new Date().toISOString()};
  await raw.withTransaction(() => raw.expenses.create({householdId:household.id,title:'Private',amountMinor:101,currency:'CHF',
    paidByMemberId:ownerMember.id,participantMemberIds:[ownerMember.id,namedMembers[0].id],splitMode:'equal',attachments:[attachment],
    occurredAt:new Date().toISOString(),createdBy:'delete-owner'}));
  const otherGroups = (await raw.households.getAll()).filter(h=>h.id!==household.id);
  const member = createScopedRepositories(raw,'delete-member');
  await expect(member.withTransaction(()=>member.households.delete(household.id))).rejects.toThrow();
  const owner = createScopedRepositories(raw,'delete-owner');
  await expect(owner.withTransaction(async()=>{await owner.households.delete(household.id);throw new Error('abort deletion');})).rejects.toThrow('abort deletion');
  expect(await owner.members.getByHousehold(household.id)).toHaveLength(2);
  expect(await owner.expenses.getByHousehold(household.id)).toHaveLength(1);
  await owner.withTransaction(()=>owner.households.delete(household.id));
  for(const table of ['members','memberships','expense_entries','todo_items','contribution_entries','categories','persistent_tasks','invitations','settlements']) {
    expect((await mockDatabase.getFirstAsync(`SELECT COUNT(*) AS n FROM ${table} WHERE householdId = ?`,[household.id])).n).toBe(0);
  }
  expect(await raw.households.getAll()).toEqual(otherGroups);
  expect(await mockDatabase.getFirstAsync('SELECT COUNT(*) AS n FROM attachment_links WHERE ref=?',[attachment.ref])).toEqual({n:0});
  const dirty=await raw.syncState.getDirtyRecords(household.id,'households',0);
  expect(dirty).toEqual([expect.objectContaining({id:household.id,payload:null,deletedAt:expect.any(String)})]);
});

test('repository pagination reads a bounded window from 50 000 entries', async () => {
  const { loadActivityHistoryPage } = await import('../src/application/use-cases/activityHistory');
  const repos = (await createSqliteRepositories())!;
  const householdId = 'bulk-history';
  const insert = native.prepare(`INSERT INTO contribution_entries
    (id, householdId, label, performedByMemberId, beneficiaryMemberIds, value, unit,
     persistentTaskId, occurredAt, createdBy, modifiedBy, categoryId,
     categoryLabelSnapshot, note, attachmentsJson, splitMode, splitWeightsJson, splitSource)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  native.exec('BEGIN');
  try {
    for (let index = 0; index < 50_000; index += 1) {
      const occurredAt = new Date(Date.UTC(2025, 0, 1) + index * 1_000).toISOString();
      insert.run(
        `bulk-${String(index).padStart(5, '0')}`, householdId, `Bulk ${index}`,
        'm1', '["m1"]', 1, 'minutes', null, occurredAt, 'u',
        null, null, null, null, null, null, null, null,
      );
    }
    native.exec('COMMIT');
  } catch (error) {
    native.exec('ROLLBACK');
    throw error;
  }

  const started = process.hrtime.bigint();
  const page = await loadActivityHistoryPage(repos, householdId, {
    limit: 20,
    filter: 'contribution',
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  expect(page.entries).toHaveLength(20);
  expect(page.hasMore).toBe(true);
  const labels = page.entries.map((entry) => {
    if (entry.type !== 'contribution') throw new Error('unexpected history type');
    return entry.entry.label;
  });
  expect(labels[0]).toBe('Bulk 49999');
  expect(labels[19]).toBe('Bulk 49980');
  expect(elapsedMs).toBeLessThan(2_000);

  native.prepare('DELETE FROM contribution_entries WHERE householdId = ?').run(householdId);
}, 30_000);

test('50 000 pending writes are read in bounded SQLite pages without skipping a revision', async () => {
  const repos = (await createSqliteRepositories())!;
  const householdId = 'bulk-outbox';
  const insert = native.prepare('INSERT INTO sync_records (id, householdId, collection, revision, updatedAt, deletedAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?)');
  native.exec('BEGIN');
  try {
    for (let i = 1; i <= 50_000; i++) {
      insert.run(`outbox-${i}`, householdId, 'contribution_entries', i, '2026-01-01T00:00:00.000Z', null, '{}');
    }
    native.exec('COMMIT');
  } catch (error) {
    native.exec('ROLLBACK');
    throw error;
  }
  const original = mockDatabase.getAllAsync;
  const returnedSizes: number[] = [];
  const query = jest.spyOn(mockDatabase, 'getAllAsync').mockImplementation(async (sql: any, ...args: any[]) => {
    const rows = await original(sql, ...args);
    if (sql.includes('FROM sync_records')) returnedSizes.push(rows.length);
    return rows;
  });
  try {
    let cursor = 0;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber <= 500; pageNumber++) {
      const page = await repos.syncState.getDirtyRecords(householdId, 'contribution_entries', cursor, 100);
      if (!page.length) break;
      expect(page.length).toBeLessThanOrEqual(100);
      expect(page[0].revision).toBeGreaterThan(cursor);
      for (const record of page) {
        if (seen.has(record.id)) throw new Error('Duplicate outbox record');
        seen.add(record.id);
      }
      cursor = page[page.length - 1].revision;
    }
    expect(seen.size).toBe(50_000);
    expect(cursor).toBe(50_000);
    expect(returnedSizes).toHaveLength(501);
    expect(Math.max(...returnedSizes)).toBe(100);
  } finally {
    query.mockRestore();
    native.prepare('DELETE FROM sync_records WHERE householdId = ?').run(householdId);
  }
}, 30_000);
