import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const files = ['requests.log', 'evaluations.log'];
const backupFiles = [...files, 'usage.sqlite', 'usage.sqlite-wal'];
const hash = b => createHash('sha256').update(b).digest('hex');
// OFFLINE ONLY: callers must stop every writer before invoking these operations.
export function snapshot(logDir, destination) {
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  const manifest = { version: 1, created_at: new Date().toISOString(), files: {} };
  for (const name of backupFiles) {
    const source = path.join(logDir, name);
    if (!fs.existsSync(source)) continue;
    const data = fs.readFileSync(source);
    fs.writeFileSync(path.join(destination, name), data, { flag: 'wx', mode: 0o600 });
    manifest.files[name] = hash(data);
  }
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}
export function restore(source, destination) {
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json')));
  if (manifest.version !== 1 || !manifest.files || Object.keys(manifest.files).some(n => !backupFiles.includes(n))) throw new Error('Invalid backup manifest');
  const verified = Object.entries(manifest.files).map(([name, expected]) => {
    const data = fs.readFileSync(path.join(source, name));
    if (hash(data) !== expected) throw new Error('Backup checksum mismatch');
    return [name, data];
  });
  // Never overwrite existing production data, even if only part of a restore fails.
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  for (const [name, data] of verified) fs.writeFileSync(path.join(destination, name), data, { flag: 'wx', mode: 0o600 });
}
export function retain(logDir, days, apply = false, now = Date.now()) {
  if (!Number.isSafeInteger(days) || days < 1) throw new Error('Retention days must be a positive integer');
  const cutoff = now - days * 86400000;
  const plans = [];
  for (const name of files) {
    const file = path.join(logDir, name);
    if (!fs.existsSync(file)) continue;
    const data = fs.readFileSync(file, 'utf8');
    if (data && !data.endsWith('\n')) throw new Error('Incomplete log record; stop writers and repair before maintenance');
    const lines = data.split('\n').filter(Boolean);
    const kept = lines.filter(line => {
      const record = JSON.parse(line);
      const time = Date.parse(record.timestamp ?? record.created_at);
      // Unknown timestamp is retained, never silently deleted.
      return !Number.isFinite(time) || time >= cutoff;
    });
    plans.push({ file, kept, removed: lines.length - kept.length });
  }
  if (apply) {
    for (const plan of plans) {
      const temp = `${plan.file}.maintenance`;
      fs.writeFileSync(temp, plan.kept.length ? plan.kept.join('\n') + '\n' : '', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, plan.file);
    }
    // Derived index is rebuildable. Remove old payloads/WAL, not just SQL rows.
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(logDir, `requests.log.sqlite${suffix}`), { force: true });
  }
  return plans.map(({ file, kept, removed }) => ({ file: path.basename(file), retained: kept.length, removed, applied: apply }));
}
