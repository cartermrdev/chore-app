/**
 * Outgoing email. Pluggable so tests and development never send real mail.
 * Only magic links use it today. A production SMTP/API mailer implements the
 * same interface and is chosen in server.ts.
 */
export type Mail = { to: string; subject: string; text: string };

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Keeps every Mail in `sent` instead of sending it (tests, e2e). */
export function createOutbox(): Mailer & { sent: Mail[] } {
  const sent: Mail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}

/** Prints the Mail to the server log (development). */
export const consoleMailer: Mailer = {
  async send(mail) {
    console.log(`[mail] to=${mail.to} subject=${JSON.stringify(mail.subject)}\n${mail.text}`);
  },
};
