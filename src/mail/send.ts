// One place for the API to send transactional mail.
//
// Two transports, picked at runtime:
//   - MAIL_RELAY_URL set  -> POST {to,from,subject,text,html} to <relay>/send
//                            with X-Relay-Token. Used in prod because
//                            Scaleway Serverless Containers silently drop
//                            outbound TCP to ports 25/465/587, so direct
//                            SMTP from the API to Mailu over the public
//                            Internet doesn't work. The relay is co-located
//                            with Mailu on the mail VPS and forwards via
//                            internal SMTP.
//   - MAIL_RELAY_URL unset -> nodemailer to SMTP_HOST:SMTP_PORT. Used in
//                             local-dev (compose stack runs mailpit on
//                             :1025) and any other env without a relay.
//
// Fire-and-forget: callers `void sendEmail(...).catch(log)` so a slow or
// failed mail never blocks a user request.
//
// All errors are logged with a `[mail]` prefix so they're greppable in
// container logs.
//
// Sources:
//   - relay handler:    prod-battle-infra/modules/mail-server/relay/relay.js
//   - relay deployment: prod-battle-infra/modules/mail-server/cloud-init.yaml.tpl

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
  from?: string;
  replyTo?: string;
}

const DEFAULT_FROM = process.env.SMTP_FROM ?? 'noreply@prodbattle.com';

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const from = input.from ?? DEFAULT_FROM;
  const relayUrl = process.env.MAIL_RELAY_URL?.trim();
  if (relayUrl) {
    await sendViaRelay(relayUrl, { ...input, from });
    return;
  }
  await sendViaSmtp({ ...input, from });
}

async function sendViaRelay(
  relayUrl: string,
  msg: SendEmailInput & { from: string },
): Promise<void> {
  const token = process.env.MAIL_RELAY_TOKEN ?? '';
  const url = `${relayUrl.replace(/\/$/, '')}/send`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-token': token,
      },
      body: JSON.stringify({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        replyTo: msg.replyTo,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`relay ${res.status}: ${body.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function sendViaSmtp(msg: SendEmailInput & { from: string }): Promise<void> {
  // Lazy-import: keeps nodemailer out of cold-start for paths that never
  // send mail (most requests). Same pattern the previous auth/config.ts
  // used inline before this helper existed.
  const nodemailer = await import('nodemailer');
  const smtpPort = Number(process.env.SMTP_PORT ?? 1025);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: smtpPort,
    secure: smtpPort === 465,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 30_000,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  await transport.sendMail({
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    replyTo: msg.replyTo,
  });
}
