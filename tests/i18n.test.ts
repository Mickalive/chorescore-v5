import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG } from '../src/i18n/catalog';
function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap(file => file.isDirectory()
    ? sources(join(folder, file.name)) : /\.tsx?$/.test(file.name) ? [join(folder, file.name)] : []);
}
test('French and English have the same non-empty translation keys', () => {
  expect(Object.keys(CATALOG.fr).sort()).toEqual(Object.keys(CATALOG.en).sort());
  for (const catalog of [CATALOG.fr, CATALOG.en]) {
    for (const value of Object.values(catalog)) expect(value.trim()).not.toBe('');
  }
});
test('every literal translation used by screens and components exists in both languages', () => {
  const missing: string[] = [];
  for (const path of [...sources('app'), ...sources('src/features'), ...sources('src/ui')]) {
    const contents = readFileSync(path, 'utf8');
    for (const match of contents.matchAll(/\bt\(['"]([^'"]+)['"]/g)) {
      for (const locale of ['fr','en'] as const) {
        if (!(match[1] in CATALOG[locale])) missing.push(`${path}: ${locale}:${match[1]}`);
      }
    }
  }
  expect(missing).toEqual([]);
});
