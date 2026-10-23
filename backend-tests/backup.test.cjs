const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { CollaborationStore } = require('../dist-backend/backend/store.js');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);

test('online backup and verified restore preserve groups, history and private media', () => {
  const root = mkdtempSync(join(tmpdir(), 'chorescore-backup-'));
  const database = join(root, 'collab.sqlite');
  const media = join(root, 'media');
  const backups = join(root, 'backups');
  const restoredDatabase = join(root, 'restored', 'collab.sqlite');
  const restoredMedia = join(root, 'restored', 'media');
  const store = new CollaborationStore(database, media);
  try {
    store.createGroup('owner-uid', {
      id: 'home', ownerMemberId: 'm-owner', ownerName: 'Owner', name: 'Maison', unit: 'points',
      members: [{ id: 'm-bob', name: 'Bob' }],
    });
    const stored = store.putMedia('owner-uid', 'home', 'photo-1', 'image/png', PNG);
    assert.equal(stored.byteSize, PNG.length);

    const manifest = JSON.parse(execFileSync(process.execPath,
      [join(__dirname, '..', 'scripts', 'backend', 'backup.mjs'), database, backups, media],
      { encoding: 'utf8' }));
    assert.equal(manifest.groups, 1);
    assert.equal(manifest.mediaFiles, 1);
    assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
    const snapshot = join(backups, manifest.database);
    assert.equal(existsSync(snapshot), true);
    assert.equal(
      require('node:crypto').createHash('sha256').update(readFileSync(snapshot)).digest('hex'),
      manifest.sha256,
    );

    // The live database keeps working while the snapshot stays immutable.
    store.putMedia('owner-uid', 'home', 'photo-2', 'image/png', PNG);
    const liveRows = new DatabaseSync(database, { readOnly: true });
    assert.equal(liveRows.prepare('SELECT COUNT(*) AS count FROM media').get().count, 2);
    liveRows.close();

    execFileSync(process.execPath,
      [join(__dirname, '..', 'scripts', 'backend', 'restore.mjs'), snapshot,
        restoredDatabase, join(backups, manifest.mediaDirectory), restoredMedia],
      { encoding: 'utf8' });
    const restored = new CollaborationStore(restoredDatabase, restoredMedia);
    try {
      const groups = restored.listGroups('owner-uid');
      assert.equal(groups.length, 1);
      assert.equal(groups[0].household.name, 'Maison');
      assert.deepEqual(restored.getMedia('owner-uid', 'home', 'photo-1').bytes, PNG);
      assert.throws(() => restored.getMedia('owner-uid', 'home', 'photo-2'), /Media not found/);
    } finally {
      restored.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
