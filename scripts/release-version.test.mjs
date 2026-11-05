import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { nextVersion, releaseDate, reserveLocalVersion } from './release-version.mjs';

test('daily revisions include reserved drafts, reset on the next Beijing date, and reject rollback', () => {
  assert.equal(releaseDate(new Date('2026-11-05T16:01:00Z')), '20261106');
  assert.equal(nextVersion('3.0.20261103-1', '20261105'), '3.0.20261105-1');
  assert.equal(nextVersion('3.0.20261103-1', '20261105', ['v3.0.20261105-9', 'v3.0.20261105-2']), '3.0.20261105-10');
  assert.equal(nextVersion('3.0.20261105-10', '20261106'), '3.0.20261106-1');
  assert.throws(() => nextVersion('3.0.20261106-1', '20261105'), /downgrade/);
  if (process.platform === 'linux') {
    for (const [newer, older] of [['3.0.20261105-10', '3.0.20261105-9'], ['3.0.20261106-1', '3.0.20261105-999']]) {
      assert.equal(spawnSync('dpkg', ['--compare-versions', newer, 'gt', older]).status, 0);
    }
  }
});

test('local reservations survive failed or repeated builds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaqh-version-'));
  try {
    const ledger = join(dir, 'version.json');
    assert.equal(reserveLocalVersion('3.0.20261103-1', ledger, '20261105'), '3.0.20261105-1');
    assert.equal(reserveLocalVersion('3.0.20261103-1', ledger, '20261105'), '3.0.20261105-2');
    assert.equal(reserveLocalVersion('3.0.20261103-1', ledger, '20261106'), '3.0.20261106-1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
