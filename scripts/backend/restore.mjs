#!/usr/bin/env node
/**
 * Verified restore of a collaboration backup produced by backup.mjs.
 *
 * Usage: node scripts/backend/restore.mjs <backup.sqlite> <target.sqlite> [backup-media-dir] [target-media-dir] [--force]
 *
 * The backup is integrity-checked before anything is replaced. Restores are
 * written to a temporary sibling and atomically renamed. Existing targets are
 * only replaced with --force, and the server must be stopped first because a
 * single writer owns the database. No credentials are involved.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2).filter((arg) => arg !== '--force');
const force = process.argv.includes('--force');
const [sourceArg, targetArg, sourceMediaArg, targetMediaArg] = args;
if (!sourceArg || !targetArg) {
  console.error('Usage: restore.mjs <backup.sqlite> <target.sqlite> [backup-media-dir] [target-media-dir] [--force]');
  process.exit(2);
}
const source = resolve(sourceArg);
const target = resolve(targetArg);
if (!existsSync(source)) throw new Error(`Backup not found: ${source}`);
if (existsSync(target) && !force) throw new Error('Target exists; pass --force after stopping the server');
if (Boolean(sourceMediaArg) !== Boolean(targetMediaArg)) {
  throw new Error('Both backup and target media directories are required together');
}

const backup = new DatabaseSync(source, { readOnly: true });
try {
  const integrity = backup.prepare('PRAGMA integrity_check').get();
  if (integrity?.integrity_check !== 'ok') throw new Error('Backup integrity check failed');
  backup.prepare('SELECT COUNT(*) AS count FROM groups').get();
} finally {
  backup.close();
}

mkdirSync(dirname(target), { recursive: true });
const temporary = `${target}.restore-${process.pid}`;
rmSync(temporary, { force: true });
cpSync(source, temporary);
renameSync(temporary, target);

let mediaFiles = 0;
if (sourceMediaArg && targetMediaArg) {
  const sourceMedia = resolve(sourceMediaArg);
  const targetMedia = resolve(targetMediaArg);
  if (!existsSync(sourceMedia)) throw new Error(`Backup media not found: ${sourceMedia}`);
  const temporaryMedia = `${targetMedia}.restore-${process.pid}`;
  rmSync(temporaryMedia, { recursive: true, force: true });
  cpSync(sourceMedia, temporaryMedia, { recursive: true });
  rmSync(targetMedia, { recursive: true, force: true });
  renameSync(temporaryMedia, targetMedia);
  mediaFiles = countFiles(targetMedia);
}

console.log(JSON.stringify({ restored: target, byteSize: statSync(target).size, mediaFiles }));

function countFiles(directory) {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(join(directory, entry.name)) : 1;
  }
  return count;
}
