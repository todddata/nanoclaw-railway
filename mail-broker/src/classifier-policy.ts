import {
  decideSpamAction,
  SpamClassification,
  SpamDecision,
} from './spam-policy.js';
import { InertEmailRecord } from './types.js';

const MODEL_CLASSIFICATIONS = new Set<SpamClassification>([
  'high_confidence_spam',
  'uncertain',
  'sensitive_or_human',
]);
const SAFE_VERSION = /^[a-zA-Z0-9._:-]{1,100}$/;
const SENSITIVE_TERMS = [
  /\b(?:bank|wire|payment|invoice|tax|payroll|credit card|financial)\b/i,
  /\b(?:attorney|legal|lawsuit|contract|subpoena)\b/i,
  /\b(?:medical|health|diagnosis|prescription|patient)\b/i,
  /\b(?:password|verification code|security alert|sign-in|login|account)\b/i,
  /\b(?:employment|candidate|interview|offer letter|termination)\b/i,
];

export interface ClassifierOutput {
  classification: Extract<
    SpamClassification,
    'high_confidence_spam' | 'uncertain' | 'sensitive_or_human'
  >;
  confidence: number;
  modelVersion: string;
}

export interface MailboxSpamPolicy {
  mailboxId: string;
  policyVersion: string;
  allowedModelVersions: string[];
  allowlistedSenders: string[];
  blocklistedSenders: string[];
  minimumQuarantineConfidence: number;
  maxActionsPerRun: number;
}

export interface EnforcedSpamDecision extends SpamDecision {
  policyVersion: string;
  modelVersion: string;
}

export function parseClassifierOutput(value: unknown): ClassifierOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Classifier output must be an object');
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (
    keys.length !== 3 ||
    !keys.every((key) =>
      ['classification', 'confidence', 'modelVersion'].includes(key),
    ) ||
    typeof input.classification !== 'string' ||
    !MODEL_CLASSIFICATIONS.has(input.classification as SpamClassification) ||
    typeof input.confidence !== 'number' ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1 ||
    typeof input.modelVersion !== 'string' ||
    !SAFE_VERSION.test(input.modelVersion)
  ) {
    throw new Error('Classifier output violates the strict schema');
  }
  return input as unknown as ClassifierOutput;
}

function normalizedSender(sender: string): string {
  return sender.trim().toLowerCase();
}

export function enforceSpamPolicy(
  record: InertEmailRecord,
  rawOutput: unknown,
  policy: MailboxSpamPolicy,
  actionsAlreadyPlanned: number,
): EnforcedSpamDecision {
  const output = parseClassifierOutput(rawOutput);
  if (record.mailboxId !== policy.mailboxId) {
    throw new Error('Mailbox has no matching spam policy');
  }
  if (!policy.allowedModelVersions.includes(output.modelVersion)) {
    throw new Error('Classifier model version is not approved');
  }
  if (
    !SAFE_VERSION.test(policy.policyVersion) ||
    !Number.isInteger(policy.maxActionsPerRun) ||
    policy.maxActionsPerRun < 0 ||
    !Number.isFinite(policy.minimumQuarantineConfidence) ||
    policy.minimumQuarantineConfidence < 0.98 ||
    policy.minimumQuarantineConfidence > 1
  ) {
    throw new Error('Mailbox spam policy is invalid');
  }

  const sender = normalizedSender(record.from);
  const senderAllowlisted = policy.allowlistedSenders
    .map(normalizedSender)
    .includes(sender);
  const senderBlocklisted = policy.blocklistedSenders
    .map(normalizedSender)
    .includes(sender);
  const sensitive = SENSITIVE_TERMS.some((pattern) =>
    pattern.test(`${record.from}\n${record.subject}\n${record.text}`),
  );

  if (actionsAlreadyPlanned >= policy.maxActionsPerRun) {
    return {
      action: 'review',
      reasonCode: 'mailbox_action_quota_reached',
      policyVersion: policy.policyVersion,
      modelVersion: output.modelVersion,
    };
  }

  const decision = decideSpamAction({
    record,
    classification: output.classification,
    confidence:
      output.confidence >= policy.minimumQuarantineConfidence
        ? output.confidence
        : 0,
    senderAllowlisted,
    senderBlocklisted,
    sensitive,
  });
  return {
    ...decision,
    policyVersion: policy.policyVersion,
    modelVersion: output.modelVersion,
  };
}

export function canPromoteSpamThreshold(input: {
  reviewedMessages: number;
  falsePositives: number;
  minimumReviewedMessages?: number;
  maximumFalsePositiveRate?: number;
}): boolean {
  const minimum = input.minimumReviewedMessages ?? 1000;
  const maximumRate = input.maximumFalsePositiveRate ?? 0.001;
  return (
    Number.isInteger(input.reviewedMessages) &&
    input.reviewedMessages >= minimum &&
    Number.isInteger(input.falsePositives) &&
    input.falsePositives >= 0 &&
    input.falsePositives / input.reviewedMessages <= maximumRate
  );
}
