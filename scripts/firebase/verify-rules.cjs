// Run inside the official `firebase emulators:exec` process. Never accept a
// green Jest exit that merely skipped the security rules acceptance tests.
const { spawnSync } = require('node:child_process');
const { mkdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is missing: official rules verification cannot be skipped.');
  process.exit(1);
}
const directory = path.resolve('verification-evidence/firestore');
mkdirSync(directory, { recursive: true });
const report = path.join(directory, 'jest.json');
const result = spawnSync(process.execPath, [
  'node_modules/jest/bin/jest.js', '--runInBand', '--runTestsByPath',
  'tests/firebaseEmulator.test.ts', '--json', '--outputFile', report,
], { stdio: 'inherit', env: { ...process.env,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --experimental-vm-modules`.trim() } });
if (result.error || result.status !== 0) {
  console.error(result.error || 'Official Firestore rules acceptance failed.');
  process.exit(1);
}
const data = JSON.parse(readFileSync(report, 'utf8'));
const assertions = data.testResults.flatMap(suite => suite.assertionResults);
if (!data.success || assertions.length < 2 || assertions.some(test => test.status !== 'passed')) {
  console.error('All official Firestore scenarios must execute and pass; skipped tests are a failure.');
  process.exit(1);
}
console.log(`PASS: ${assertions.length} official Firestore acceptance scenarios executed without skips.`);
