#!/usr/bin/env node
/**
 * Consistent online backup of the collaboration store.
 *
 * Usage: node scripts/backend/backup.mjs <database.sqlite> <destination-dir> [media-dir]
 *
 * Uses SQLite VACUUM INTO so a running WAL database is copied as a single
 * consistent snapshot without stopping the writer. Media files are copied
 * next to the snapshot; a manifest records hashes so a restore can verify it.
 * No credentials are read or written.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

const [databasePath, destinationArg, mediaArg] = process.argv.slice(2);
if (!databasePath || !destinationArg) {
  console.error('Usage: backup.mjs <database.sqlite> <destination-dir> [media-dir]');
  process.exit(2);
}

const database = resolve(databasePath);
if (!existsSync(database)) throw new Error(`Database not found: ${database}`);
const destination = resolve(destinationArg);
const media = mediaArg ? resolve(mediaArg) : null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const snapshotName = `collab-${stamp}.sqlite`;
const mediaName = `collab-${stamp}.media`;

mkdirSync(destination, { recursive: true, mode: 0o700 });
const snapshot = join(destination, snapshotName);
const temporary = `${snapshot}.tmp`;
rmSync(temporary, { force: true });

const db = new DatabaseSync(database, { readOnly: true });
let rowCount;
try {
  db.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
  const result = db.prepare('PRAGMA integrity_check').get();
  if (result?.integrity_check !== 'ok') throw new Error('Source integrity check failed');
  rowCount = db.prepare('SELECT COUNT(*) AS count FROM groups').get()?.count ?? 0;
} finally {
  db.close();
}
renameSync(temporary, snapshot);

let mediaEntries = 0;
if (media && existsSync(media)) {
  const mediaDestination = join(destination, mediaName);
  rmSync(mediaDestination, { recursive: true, force: true });
  cpSync(media, mediaDestination, { recursive: true });
  mediaEntries = countFiles(mediaDestination);
}

const sha256 = createHash('sha256').update(readFileSync(snapshot)).digest('hex');
const manifest = {
  createdAt: new Date().toISOString(),
  database: basename(snapshot),
  sha256,
  byteSize: statSync(snapshot).size,
  groups: rowCount,
  mediaDirectory: media && existsSync(media) ? mediaName : null,
  mediaFiles: mediaEntries,
};
writeFileSync(join(destination, `collab-${stamp}.manifest.json`),
  `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(manifest));

function countFiles(directory) {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(join(directory, entry.name)) : 1;
  }
  return count;
}
