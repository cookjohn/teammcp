/**
 * i18n message guard.
 *
 * vue-i18n's message compiler treats `@`, `{}`, and `|` as syntax. An
 * unescaped literal `@` (e.g. "@ to mention", "@openai/codex") throws a
 * SyntaxError at runtime that aborts the whole component render — the symptom
 * is a silently missing element (e.g. the channel compose box vanished).
 *
 * This script feeds every message string through the SAME compiler vue-i18n
 * uses, so any string that would crash at runtime fails the build here
 * instead. Literal `@` must be written as {'@'} to be safe.
 *
 * Runs as `prebuild` — `npm run build` will refuse to produce a bundle with
 * a broken translation.
 */
import { baseCompile } from '@intlify/message-compiler';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const I18N_DIR = join(__dirname, '..', 'src', 'i18n');
const LOCALES = ['en.js', 'zh.js'];

// Flatten a nested message object into [keyPath, value] pairs for string leaves.
function* walk(obj, prefix = '') {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      yield [path, v];
    } else if (v && typeof v === 'object') {
      yield* walk(v, path);
    }
  }
}

function compileOrError(message) {
  let captured = null;
  try {
    baseCompile(message, { onError(e) { throw e; } });
  } catch (e) {
    captured = e?.message || String(e);
  }
  return captured;
}

let totalChecked = 0;
const failures = [];

for (const file of LOCALES) {
  const modPath = join(I18N_DIR, file);
  const mod = await import(`file://${modPath.replace(/\\/g, '/')}`);
  const messages = mod.default;
  for (const [keyPath, value] of walk(messages)) {
    totalChecked++;
    const err = compileOrError(value);
    if (err) {
      failures.push({ file, keyPath, value, err });
    }
  }
}

if (failures.length === 0) {
  console.log(`[check-i18n] OK — ${totalChecked} message(s) compiled cleanly across ${LOCALES.length} locale(s)`);
  process.exit(0);
}

console.error(`\n[check-i18n] FAILED — ${failures.length} message(s) will crash vue-i18n at runtime:\n`);
for (const f of failures) {
  console.error(`  ✗ ${f.file} → ${f.keyPath}`);
  console.error(`    value: ${JSON.stringify(f.value)}`);
  console.error(`    error: ${f.err}`);
  console.error(`    fix:   escape literal "@" as {'@'} (e.g. "{'@'}openai/codex"), or check {} / | usage\n`);
}
process.exit(1);
