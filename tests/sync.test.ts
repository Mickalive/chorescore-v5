import { InMemorySyncStateRepository } from '../src/infrastructure/repositories/InMemoryRepositories';
import { pushDeltas } from '../src/domain/services/syncEngine';
import { SyncRecord } from '../src/domain/entities';
async function dirty(state: InMemorySyncStateRepository, id = 'entry'): Promise<SyncRecord> {
  const record: SyncRecord = { id, householdId: 'g', collection: 'contribution_entries',
    revision: await state.nextLocalRevision('g','contribution_entries'),
    updatedAt: new Date().toISOString(), deletedAt: null, payload: JSON.stringify({ id }) };
  await state.storeLocalRecords('g','contribution_entries',[record]);
  return record;
}

test('bounded outbox pages are revision ordered even after an older record is edited again', async () => {
  const state = new InMemorySyncStateRepository();
  await dirty(state, 'first');
  await dirty(state, 'second');
  await dirty(state, 'first');
  const first = await state.getDirtyRecords('g', 'contribution_entries', 0, 1);
  expect(first.map(record => record.id)).toEqual(['second']);
  const next = await state.getDirtyRecords('g', 'contribution_entries', first[0].revision, 1);
  expect(next.map(record => record.id)).toEqual(['first']);
  expect(await state.getDirtyRecords('g', 'contribution_entries', 0, 0)).toEqual([]);
  await expect(state.getDirtyRecords('g', 'contribution_entries', 0, -1)).rejects.toThrow('limit');
});

test('remote revisions never skip new local writes', async () => {
  const state = new InMemorySyncStateRepository();
  const first = await dirty(state);
  await pushDeltas(state,'g',async (_,records) => records.map(r => ({ ...r, revision: 5000 })));
  expect((await state.getCursor('g','contribution_entries'))!.lastRevision).toBe(first.revision);
  await dirty(state, 'second');
  const result = await pushDeltas(state,'g',async (_,records) => records);
  expect(result.totalPushed).toBe(1);
});

test('editing while upload is in flight keeps the newer version pending', async () => {
  const state = new InMemorySyncStateRepository();
  const first = await dirty(state);
  await pushDeltas(state,'g',async (_,records) => {
    await dirty(state); // same entity, later local version
    return records;
  });
  const cursor = (await state.getCursor('g','contribution_entries'))!;
  expect(cursor.lastRevision).toBe(first.revision);
  const remaining = await state.getDirtyRecords('g','contribution_entries',cursor.lastRevision);
  expect(remaining).toHaveLength(1);
  expect(remaining[0].revision).toBeGreaterThan(first.revision);
});

test('partial or wrong acknowledgements never advance an outbox cursor', async () => {
  const state = new InMemorySyncStateRepository();
  await dirty(state,'one'); await dirty(state,'two');
  await expect(pushDeltas(state,'g',async (_,records) => records.slice(0,1))).rejects.toThrow('Incomplete');
  expect(await state.getCursor('g','contribution_entries')).toBeNull();
  await expect(pushDeltas(state,'g',async () => [])).rejects.toThrow('Incomplete');
  expect(await state.getDirtyRecords('g','contribution_entries',0)).toHaveLength(2);
});
