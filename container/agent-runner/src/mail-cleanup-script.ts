const SAFE_MAILBOX = /^[a-zA-Z0-9@._+\-=]{1,320}$/;

export function isHardenedMailCleanupScript(script: string): boolean {
  try {
    const parsed = JSON.parse(script) as Record<string, unknown>;
    const cleanupKeys = [
      'version',
      'type',
      'provider',
      'mailboxId',
      'action',
      'maxMessages',
      'maxActions',
    ];
    const reviewKeys = [
      'version',
      'type',
      'provider',
      'mailboxId',
      'action',
      'reviewRef',
    ];
    const exact = (keys: string[]) =>
      Object.keys(parsed).length === keys.length &&
      Object.keys(parsed).every((key) => keys.includes(key));
    const common =
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      parsed.version === 1 &&
      (parsed.provider === 'gmail' || parsed.provider === 'microsoft') &&
      typeof parsed.mailboxId === 'string' &&
      SAFE_MAILBOX.test(parsed.mailboxId);
    if (common && exact(reviewKeys) && parsed.type === 'mail_review_action') {
      return (
        (parsed.action === 'recoverable_trash' ||
          parsed.action === 'restore') &&
        typeof parsed.reviewRef === 'string' &&
        /^MR-[A-Z0-9_-]{16}$/.test(parsed.reviewRef)
      );
    }
    return !!(
      common &&
      exact(cleanupKeys) &&
      parsed.type === 'mail_spam_cleanup' &&
      (parsed.action === 'report' ||
        parsed.action === 'recoverable_trash_provider_spam') &&
      Number.isSafeInteger(parsed.maxMessages) &&
      (parsed.maxMessages as number) >= 1 &&
      (parsed.maxMessages as number) <= 100 &&
      Number.isSafeInteger(parsed.maxActions) &&
      (parsed.maxActions as number) >= 1 &&
      (parsed.maxActions as number) <= 50 &&
      (parsed.maxActions as number) <= (parsed.maxMessages as number)
    );
  } catch {
    return false;
  }
}
