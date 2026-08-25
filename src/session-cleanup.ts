import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { getAllSessions } from './db.js';
import { logger } from './logger.js';

const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;

function retentionDays(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function olderThan(filePath: string, days: number): boolean {
  return Date.now() - fs.statSync(filePath).mtimeMs > days * 24 * 60 * 60 * 1000;
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...walkFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function removeOldFiles(
  root: string,
  days: number,
  keep?: (filePath: string) => boolean,
): number {
  let removed = 0;
  for (const filePath of walkFiles(root)) {
    if (keep?.(filePath) || !olderThan(filePath, days)) continue;
    fs.unlinkSync(filePath);
    removed++;
  }
  return removed;
}

function runCleanup(): void {
  try {
    const activeSessionIds = new Set(Object.values(getAllSessions()));
    const sessionDays = retentionDays('SESSION_RETENTION_DAYS', 7);
    const debugDays = retentionDays('DEBUG_LOG_RETENTION_DAYS', 3);
    const logDays = retentionDays('GROUP_LOG_RETENTION_DAYS', 7);
    const sessionsRoot = path.join(DATA_DIR, 'sessions');
    let removed = 0;

    if (fs.existsSync(sessionsRoot)) {
      for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const claudeRoot = path.join(sessionsRoot, entry.name, '.claude');
        removed += removeOldFiles(
          path.join(claudeRoot, 'projects'),
          sessionDays,
          (filePath) =>
            filePath.endsWith('.jsonl') &&
            activeSessionIds.has(path.basename(filePath, '.jsonl')),
        );
        removed += removeOldFiles(path.join(claudeRoot, 'debug'), debugDays);
        removed += removeOldFiles(path.join(claudeRoot, 'todos'), debugDays);
        removed += removeOldFiles(path.join(claudeRoot, 'telemetry'), sessionDays);
      }
    }

    if (fs.existsSync(GROUPS_DIR)) {
      for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        removed += removeOldFiles(path.join(GROUPS_DIR, entry.name, 'logs'), logDays);
      }
    }

    logger.info(
      { removed, sessionDays, debugDays, logDays },
      'Session retention cleanup complete',
    );
  } catch (err) {
    logger.error({ err }, 'Session retention cleanup failed');
  }
}

export function startSessionCleanup(): void {
  setTimeout(runCleanup, 30_000);
  setInterval(runCleanup, CLEANUP_INTERVAL);
}
