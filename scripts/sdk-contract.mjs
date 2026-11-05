import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(root, '../qaqh-backend');
const generated = resolve(root, '../qaqh-sdk/src/protocol/generated');
const mirror = join(root, 'webui/src/api/qaqh');

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: backend, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal || result.status})`);
  return result.stdout.trim();
}

function files(directory, prefix = '') {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = prefix + entry.name;
    return entry.isDirectory() ? files(join(directory, entry.name), path + '/') : [path];
  }).sort();
}

export function contractDifferences(expected, actual) {
  const wanted = files(expected);
  const present = files(actual);
  const changes = [];
  for (const path of new Set([...wanted, ...present])) {
    if (!wanted.includes(path)) changes.push(`多余文件: ${path}`);
    else if (!present.includes(path)) changes.push(`缺失文件: ${path}`);
    else if (!readFileSync(join(expected, path)).equals(readFileSync(join(actual, path)))) {
      changes.push(`文件内容不同: ${path}`);
      if (path === 'manifest.json') {
        try {
          const a = JSON.parse(readFileSync(join(actual, path), 'utf8'));
          const e = JSON.parse(readFileSync(join(expected, path), 'utf8'));
          for (const key of new Set([...Object.keys(a), ...Object.keys(e)])) {
            if (key !== 'files' && JSON.stringify(a[key]) !== JSON.stringify(e[key])) {
              changes.push(`  ${key}: ${JSON.stringify(a[key])} → ${JSON.stringify(e[key])}`);
            }
          }
        } catch { changes.push('  清单无法解析为 JSON'); }
      }
    }
  }
  return changes;
}

export function sdkContract(sync = false) {
  const revision = run('git', ['rev-parse', 'HEAD']);
  const dirty = run('git', ['status', '--porcelain']) !== '';
  const env = { ...process.env, QAQH_SOURCE_REVISION: dirty ? 'development' : revision, QAQH_SOURCE_DIRTY: dirty ? '1' : '0' };
  const cargo = (command, flag, target) => run('cargo', [
    'run', '--locked', '-p', 'qaqh-contract-export', '--', command, flag, target,
    ...(!dirty ? ['--release'] : []),
  ], env);
  console.log(`契约来源: ${env.QAQH_SOURCE_REVISION} (dirty=${dirty})`);
  if (sync) {
    cargo('export', '--out', generated);
    cargo('check', '--against', generated);
    // 此目录只容纳后端生成的 DTO；同步时删除废弃类型。
    rmSync(mirror, { recursive: true, force: true });
    cpSync(join(generated, 'types/qaqh'), mirror, { recursive: true });
    console.log('SDK 契约校验通过，WebUI 类型镜像已同步。请审查两个仓库的 git diff。');
    return;
  }
  const temporary = mkdtempSync(join(tmpdir(), 'qaqh-sdk-contract-'));
  try {
    const expected = join(temporary, 'generated');
    cargo('export', '--out', expected);
    const changes = contractDifferences(expected, generated);
    if (changes.length) throw new Error(`SDK 契约不一致:\n${changes.join('\n')}\n请运行 just sdk-sync，审查生成变更后重新打包。`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['check', 'sync'].includes(args[0])) throw new Error('Usage: node scripts/sdk-contract.mjs check|sync');
    sdkContract(args[0] === 'sync');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
