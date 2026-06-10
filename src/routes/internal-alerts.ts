// Alertmanager -> email adapter.
//
// Scaleway drops outbound TCP 25/465/587 from VPC-attached resources, and
// Kapsule nodes are VPC-attached - so Alertmanager can never speak SMTP to
// the mail VM directly (observed: 21 failed notification attempts, all
// "dial tcp <mail>:465: connect: connection timed out"). HTTPS (443) is
// not dropped, and the mail VM already runs an authenticated HTTPS relay
// for exactly this reason (the api's own transactional mail uses it).
//
// This route accepts Alertmanager's webhook payload and forwards a plain
// text email through that relay. Exposure: like /metrics, it rejects any
// request carrying X-Forwarded-For, so it is unreachable through the
// public ingress - only cluster-internal callers (Alertmanager) can hit
// the pod directly.

import { Hono } from 'hono';

export const internalAlertsRoutes = new Hono();

type AmAlert = {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
};

type AmWebhook = {
  status?: string;
  alerts?: AmAlert[];
  groupLabels?: Record<string, string>;
};

function formatAlert(a: AmAlert): string {
  const name = a.labels?.alertname ?? 'unknown';
  const sev = a.labels?.severity ?? '-';
  const ns = a.labels?.namespace ?? '-';
  const summary = a.annotations?.summary ?? a.annotations?.description ?? '';
  return `[${(a.status ?? 'firing').toUpperCase()}] ${name} (severity=${sev}, namespace=${ns})\n  ${summary}\n  since: ${a.startsAt ?? '?'}`;
}

internalAlertsRoutes.post('/internal/alertmanager', async (c) => {
  // Cluster-internal only - same gate as /metrics.
  if (c.req.header('x-forwarded-for')) {
    return c.notFound();
  }

  // Same direct process.env reads as src/mail/send.ts - these are mail
  // plumbing, intentionally outside the zod env schema.
  const relayUrl = process.env.MAIL_RELAY_URL?.trim();
  const relayToken = process.env.MAIL_RELAY_TOKEN ?? '';
  if (!relayUrl || !relayToken || relayToken === '-') {
    console.warn('[alerts] mail relay not configured; dropping alert notification');
    return c.json({ ok: false, reason: 'relay_not_configured' }, 200);
  }

  let payload: AmWebhook;
  try {
    payload = (await c.req.json()) as AmWebhook;
  } catch {
    return c.json({ error: 'bad_json' }, 400);
  }

  const alerts = payload.alerts ?? [];
  if (alerts.length === 0) return c.json({ ok: true, sent: 0 });

  const firing = alerts.filter((a) => a.status !== 'resolved').length;
  const resolved = alerts.length - firing;
  const headline =
    firing > 0 ? `${firing} alert${firing === 1 ? '' : 's'} firing` : `${resolved} resolved`;
  const names = [...new Set(alerts.map((a) => a.labels?.alertname ?? 'unknown'))].join(', ');

  const to = process.env.ALERT_EMAIL ?? 'brampescheck@gmail.com';
  const body = {
    from: process.env.SMTP_FROM ?? 'noreply@prodbattle.com',
    to,
    subject: `[prod-battle] ${headline}: ${names}`,
    text: `${alerts.map(formatAlert).join('\n\n')}\n\n-- Alertmanager via api relay adapter`,
  };

  try {
    const res = await fetch(`${relayUrl.replace(/\/$/, '')}/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-token': relayToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[alerts] relay returned ${res.status}: ${text.slice(0, 200)}`);
      return c.json({ ok: false, relayStatus: res.status }, 502);
    }
    console.log(`[alerts] emailed ${alerts.length} alert(s) to ${to} (${names})`);
    return c.json({ ok: true, sent: alerts.length });
  } catch (err) {
    console.warn('[alerts] relay call failed:', (err as Error).message);
    return c.json({ ok: false, error: 'relay_unreachable' }, 502);
  }
});
