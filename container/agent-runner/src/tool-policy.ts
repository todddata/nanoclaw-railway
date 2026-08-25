import fs from 'fs';
import path from 'path';

import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

export interface WorkspacePolicy {
  group: string;
  global?: string;
  extra?: string;
}

const WRITE_TOOLS = new Set(['Write', 'Edit']);
const PATH_FIELDS: Record<string, string> = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  Glob: 'path',
  Grep: 'path',
};

function canonicalize(candidate: string): string {
  let cursor = path.resolve(candidate);
  const missing: string[] = [];

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return path.resolve(candidate);
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }

  return path.join(fs.realpathSync.native(cursor), ...missing);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function hasTraversalPattern(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (path.isAbsolute(value)) return true;
  return value.split(/[\\/]+/).includes('..');
}

export function validateWorkspaceTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  policy: WorkspacePolicy,
): { allowed: true } | { allowed: false; reason: string } {
  const field = PATH_FIELDS[toolName];
  if (!field) {
    return { allowed: false, reason: `Tool ${toolName} is not permitted in the restricted Railway runtime.` };
  }

  if ((toolName === 'Glob' || toolName === 'Grep') && hasTraversalPattern(toolInput.pattern ?? toolInput.glob)) {
    return { allowed: false, reason: 'Absolute and parent-traversing search patterns are not permitted.' };
  }

  const rawPath = toolInput[field];
  if (rawPath !== undefined && typeof rawPath !== 'string') {
    return { allowed: false, reason: `Invalid ${field} supplied to ${toolName}.` };
  }

  const groupRoot = canonicalize(policy.group);
  const globalRoot = policy.global ? canonicalize(policy.global) : undefined;
  const extraRoot = policy.extra ? canonicalize(policy.extra) : undefined;
  const candidate = canonicalize(
    rawPath && rawPath.length > 0 ? path.resolve(groupRoot, rawPath) : groupRoot,
  );

  const inGroup = isWithin(groupRoot, candidate);
  const inGlobal = globalRoot ? isWithin(globalRoot, candidate) : false;
  const inExtra = extraRoot ? isWithin(extraRoot, candidate) : false;

  if (WRITE_TOOLS.has(toolName)) {
    if (!inGroup || inExtra) {
      return {
        allowed: false,
        reason: 'Writes are limited to the assigned group workspace; shared and extra workspaces are read-only.',
      };
    }
    return { allowed: true };
  }

  if (!inGroup && !inGlobal && !inExtra) {
    return {
      allowed: false,
      reason: 'Reads and searches are limited to the assigned, shared, and explicitly provided workspaces.',
    };
  }

  return { allowed: true };
}

export function createWorkspacePolicyHook(policy: WorkspacePolicy): HookCallback {
  return async (input) => {
    const preInput = input as PreToolUseHookInput;
    const result = validateWorkspaceTool(
      preInput.tool_name,
      (preInput.tool_input || {}) as Record<string, unknown>,
      policy,
    );

    if (result.allowed) return {};

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: result.reason,
      },
    };
  };
}
