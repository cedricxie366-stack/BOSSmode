import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { backupBuilderState, restoreBuilderState } = require('../runtime/backup.cjs');
const [action, source, destination] = process.argv.slice(2);
if (!source || !destination || !['backup', 'restore'].includes(action)) {
  throw new Error('Usage: node scripts/state-archive.mjs backup SOURCE.sqlite NEW_ARCHIVE_DIR | restore ARCHIVE_DIR NEW_RECOVERY_DIR');
}
const result = action === 'backup'
  ? await backupBuilderState(source, destination)
  : await restoreBuilderState(source, destination);
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
