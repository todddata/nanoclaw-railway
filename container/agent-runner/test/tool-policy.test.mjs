import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateWorkspaceTool } from '../dist/tool-policy.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-policy-'));
  const group = path.join(root, 'groups', 'current');
  const sibling = path.join(root, 'groups', 'sibling');
  const global = path.join(root, 'groups', 'global');
  const extra = path.join(group, 'extra');
  const app = path.join(root, 'app');
  for (const dir of [group, sibling, global, extra, app]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return { root, group, sibling, global, extra, app };
}

test('allows assigned-workspace reads and writes', () => {
  const f = fixture();
  const policy = { group: f.group, global: f.global, extra: f.extra };
  assert.deepEqual(validateWorkspaceTool('Read', { file_path: 'notes.md' }, policy), { allowed: true });
  assert.deepEqual(validateWorkspaceTool('Write', { file_path: 'notes.md' }, policy), { allowed: true });
});

test('denies application and sibling-workspace access', () => {
  const f = fixture();
  const policy = { group: f.group, global: f.global, extra: f.extra };
  assert.equal(validateWorkspaceTool('Read', { file_path: f.app }, policy).allowed, false);
  assert.equal(validateWorkspaceTool('Write', { file_path: f.sibling }, policy).allowed, false);
});

test('treats shared and extra workspaces as read-only', () => {
  const f = fixture();
  const policy = { group: f.group, global: f.global, extra: f.extra };
  assert.equal(validateWorkspaceTool('Read', { file_path: f.global }, policy).allowed, true);
  assert.equal(validateWorkspaceTool('Write', { file_path: f.global }, policy).allowed, false);
  assert.equal(validateWorkspaceTool('Read', { file_path: f.extra }, policy).allowed, true);
  assert.equal(validateWorkspaceTool('Write', { file_path: f.extra }, policy).allowed, false);
});

test('denies traversal and symlink escapes', () => {
  const f = fixture();
  const outside = path.join(f.app, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  fs.symlinkSync(f.app, path.join(f.group, 'escape'));
  const policy = { group: f.group, global: f.global, extra: f.extra };
  assert.equal(validateWorkspaceTool('Read', { file_path: 'escape/secret.txt' }, policy).allowed, false);
  assert.equal(validateWorkspaceTool('Glob', { pattern: '../**/*' }, policy).allowed, false);
});

test('denies tools outside the restricted allowlist', () => {
  const f = fixture();
  assert.equal(validateWorkspaceTool('Bash', { command: 'id' }, { group: f.group }).allowed, false);
});
