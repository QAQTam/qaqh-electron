import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(root, '../qaqh-backend');
// 协议运行时已由 native 绑定直接编译进 qaqh-client（同一 workspace，无副本）；
// 唯一需要物化的契约产物是 renderer 的 TS 类型镜像。
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
  const temporary = mkdtempSync(join(tmpdir(), 'qaqh-contract-'));
  try {
    const expected = join(temporary, 'generated');
    cargo('export', '--out', expected);
    const expectedTypes = join(expected, 'types/qaqh');
    if (sync) {
      rmSync(mirror, { recursive: true, force: true });
      cpSync(expectedTypes, mirror, { recursive: true });
      console.log('契约导出校验通过，WebUI 类型镜像已同步。请审查 webui/src/api/qaqh 的 git diff。');
      return;
    }
    const changes = contractDifferences(expectedTypes, mirror);
    if (changes.length) throw new Error(`WebUI 契约镜像与后端导出不一致:\n${changes.join('\n')}\n请运行 just sdk-sync，审查生成变更后重新打包。`);
    console.log('契约校验通过：WebUI 类型镜像与后端导出逐文件一致。');
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
