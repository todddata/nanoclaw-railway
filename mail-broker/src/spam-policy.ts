import { InertEmailRecord } from './types.js';

export type SpamClassification =
  | 'provider_spam'
  | 'explicit_blocklist'
  | 'high_confidence_spam'
  | 'uncertain'
  | 'sensitive_or_human';

export interface SpamDecisionInput {
  record: InertEmailRecord;
  classification: SpamClassification;
  confidence: number;
  senderAllowlisted: boolean;
  senderBlocklisted: boolean;
  sensitive: boolean;
}

export interface SpamDecision {
  action: 'trash' | 'quarantine' | 'review';
  reasonCode: string;
  quarantineDays?: number;
}

export function decideSpamAction(input: SpamDecisionInput): SpamDecision {
  if (
    input.senderAllowlisted ||
    input.sensitive ||
    input.classification === 'sensitive_or_human'
  ) {
    return { action: 'review', reasonCode: 'protected_or_sensitive' };
  }
  if (input.record.providerSpam || input.senderBlocklisted) {
    return { action: 'trash', reasonCode: 'provider_or_blocklist_spam' };
  }
  if (
    input.classification === 'high_confidence_spam' &&
    Number.isFinite(input.confidence) &&
    input.confidence >= 0.98
  ) {
    return {
      action: 'quarantine',
      reasonCode: 'high_confidence_spam',
      quarantineDays: 7,
    };
  }
  return { action: 'review', reasonCode: 'uncertain' };
}
