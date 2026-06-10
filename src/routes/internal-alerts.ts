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

// Per-namespace LogQL used to enrich the alert email with the actual log
// lines behind the numbers. Conservative selectors: error-shaped lines
// only, so the email stays readable.
function logQueryFor(ns: string): string {
  if (ns === 'app') {
    return '{namespace="app", pod=~"api-.*"} |~ "\\"level\\":\\"(error|fatal)\\"|panic|FATAL|ERR"';
  }
  if (ns === 'ingress-nginx') {
    // Positional status extraction - a loose " 5xx " regex matches the
    // request_length field on healthy lines (learned the hard way on the
    // Grafana panel).
    return '{namespace="ingress-nginx"} | pattern "<_> - <_> [<_>] \\"<_>\\" <status> <_>" | status =~ "5.."';
  }
  // Match level markers only (logfmt level=error / JSON "level":"error").
  // A loose (?i)error matched Loki's own query logs - info lines that
  // merely CONTAIN the word error because our query string is embedded
  // in them - which filled the first enriched email with noise.
  return `{namespace="${ns}"} |~ "level=(error|fatal)|\\"level\\":\\"(error|fatal)\\""`;
}

// Fetch recent matching log lines from Loki for the namespaces involved
// in this notification. Best-effort: any failure degrades to a note in
// the email rather than blocking delivery.
async function recentLogs(namespaces: string[]): Promise<string> {
  const lokiUrl = process.env.LOKI_URL?.trim();
  if (!lokiUrl) return '';

  const sections: string[] = [];
  const end = Date.now() * 1_000_000;
  const start = end - 15 * 60 * 1_000_000_000; // last 15 minutes

  for (const ns of namespaces) {
    try {
      const qs = new URLSearchParams({
        query: logQueryFor(ns),
        limit: '15',
        start: String(start),
        end: String(end),
        direction: 'backward',
      });
      const res = await fetch(
        `${lokiUrl.replace(/\/$/, '')}/loki/api/v1/query_range?${qs.toString()}`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) {
        sections.push(`Recent logs (${ns}): unavailable (loki ${res.status})`);
        continue;
      }
      const data = (await res.json()) as {
        data?: { result?: Array<{ stream?: { pod?: string }; values?: [string, string][] }> };
      };
      const lines: string[] = [];
      for (const stream of data.data?.result ?? []) {
        for (const [tsNs, line] of stream.values ?? []) {
          const ts = new Date(Number(tsNs) / 1_000_000).toISOString();
          lines.push(`  ${ts}  [${stream.stream?.pod ?? ns}] ${line.slice(0, 300)}`);
        }
      }
      lines.sort().reverse();
      sections.push(
        lines.length > 0
          ? `Recent logs (${ns}, last 15m, newest first):\n${lines.slice(0, 15).join('\n')}`
          : `Recent logs (${ns}): no matching error lines in the last 15m.`,
      );
    } catch (err) {
      sections.push(`Recent logs (${ns}): unavailable (${(err as Error).message})`);
    }
  }
  return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : '';
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
    // 503, not 200: a 2xx makes Alertmanager mark the notification
    // delivered and never retry - a silent drop. 503 keeps it retrying
    // until the relay env shows up (observed live during the
    // MAIL_RELAY_URL gap after the cutover).
    console.warn('[alerts] mail relay not configured; alert delivery deferred');
    return c.json({ ok: false, reason: 'relay_not_configured' }, 503);
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

  // No hardcoded fallback: this repo is public and a personal inbox does
  // not belong in source. ALERT_EMAIL comes from the api-env ConfigMap;
  // when missing we defer (503) so Alertmanager retries rather than
  // silently dropping.
  const to = process.env.ALERT_EMAIL?.trim();
  if (!to) {
    console.warn('[alerts] ALERT_EMAIL not configured; alert delivery deferred');
    return c.json({ ok: false, reason: 'alert_email_not_configured' }, 503);
  }
  const namespaces = [
    ...new Set(alerts.map((a) => a.labels?.namespace).filter(Boolean)),
  ] as string[];
  const logs = await recentLogs(namespaces);
  const body = {
    from: process.env.SMTP_FROM ?? 'noreply@prodbattle.com',
    to,
    subject: `[prod-battle] ${headline}: ${names}`,
    text: `${alerts.map(formatAlert).join('\n\n')}${logs}\n\n-- Alertmanager via api relay adapter`,
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
