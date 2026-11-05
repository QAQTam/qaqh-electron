import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractDifferences } from './sdk-contract.mjs';

test('reports metadata and damaged DTOs together, including missing and extra files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contract-test-'));
  try {
    const expected = join(dir, 'expected');
    const actual = join(dir, 'actual');
    mkdirSync(expected); mkdirSync(actual);
    writeFileSync(join(expected, 'manifest.json'), JSON.stringify({ source_revision: 'abc', source_dirty: false }));
    writeFileSync(join(actual, 'manifest.json'), JSON.stringify({ source_revision: 'development', source_dirty: true }));
    writeFileSync(join(expected, 'dto.ts'), '// generated\nexport type DTO = string;\n');
    writeFileSync(join(actual, 'dto.ts'), '// generated\\nexport type DTO = string;\\n');
    writeFileSync(join(expected, 'new.ts'), '');
    writeFileSync(join(actual, 'old.ts'), '');
    const changes = contractDifferences(expected, actual).join('\n');
    assert.match(changes, /source_revision: "development" → "abc"/);
    assert.match(changes, /source_dirty: true → false/);
    assert.match(changes, /文件内容不同: dto.ts/);
    assert.match(changes, /缺失文件: new.ts/);
    assert.match(changes, /多余文件: old.ts/);
    assert.deepEqual(contractDifferences(expected, expected), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
