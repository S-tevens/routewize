import path from 'node:path';
import { snapshot, restore, retain } from '../src/operations/logMaintenance.js';
const [command, ...args] = process.argv.slice(2);
try {
  if (!args.includes('--offline')) throw new Error('Stop all gateway processes, then supply --offline to acknowledge offline maintenance');
  const values = args.filter(a => !a.startsWith('--'));
  let result;
  if (command === 'backup' && values.length === 2) result = snapshot(path.resolve(values[0]), path.resolve(values[1]));
  else if (command === 'restore' && values.length === 2) result = restore(path.resolve(values[0]), path.resolve(values[1])) ?? { restored: true };
  else if (command === 'retain' && values.length === 2) result = retain(path.resolve(values[0]), Number(values[1]), args.includes('--apply'));
  else throw new Error('Usage: backup LOG_DIR NEW_BACKUP_DIR | restore BACKUP_DIR NEW_LOG_DIR | retain LOG_DIR DAYS [--apply], all with --offline');
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
