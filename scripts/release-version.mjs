import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now).replaceAll('-', '');
}

export function nextVersion(base, today, allocated = []) {
  const parse = value => /^(\d+\.\d+)\.(\d{8})-([1-9]\d*)$/.exec(value.replace(/^v/, ''));
  const source = parse(base);
  if (!source || !/^\d{8}$/.test(today)) throw new Error('Expected major.minor.YYYYMMDD-revision and YYYYMMDD date');
  let revision = 0;
  for (const value of [base, ...allocated]) {
    const match = parse(value);
    if (!match || match[1] !== source[1]) continue;
    if (match[2] > today) throw new Error(`Clock/date would downgrade an allocated release: ${value}`);
    if (match[2] === today) revision = Math.max(revision, Number(match[3]));
  }
  if (!Number.isSafeInteger(revision + 1)) throw new Error('Release revision exhausted');
  return `${source[1]}.${today}-${revision + 1}`;
}

// Local builds reserve numbers before compilation; failed builds consume their number.
export function reserveLocalVersion(base, ledger, today = releaseDate()) {
  mkdirSync(dirname(ledger), { recursive: true });
  const lock = `${ledger}.lock`;
  const fd = openSync(lock, 'wx');
  try {
    const allocated = existsSync(ledger) ? [JSON.parse(readFileSync(ledger, 'utf8')).version] : [];
    const version = nextVersion(base, today, allocated);
    writeFileSync(`${ledger}.tmp`, JSON.stringify({ version }) + '\n');
    renameSync(`${ledger}.tmp`, ledger);
    return version;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tagsFile] = process.argv.slice(2);
  if (!tagsFile) throw new Error('Usage: node scripts/release-version.mjs <allocated-release-tags-file>');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const base = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  console.log(nextVersion(base, releaseDate(), readFileSync(tagsFile, 'utf8').split(/\s+/).filter(Boolean)));
}
