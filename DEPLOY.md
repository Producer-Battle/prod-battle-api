# Deployment Guide

Prod runs on a Scaleway Kapsule (Kubernetes) cluster provisioned by the
`prod-battle-infra` repo. Images live on GitHub Container Registry. There is
no staging environment: local dev (docker compose) and prod.

## Pipeline overview

`.github/workflows/deploy.yml` runs on every push to `main`:

1. **meta** - computes the image tag set: `<short-sha>` (immutable) and
   `latest` (floating bootstrap tag).
2. **build** - builds the API image and the `jobs/ffmpeg` image, pushes both
   to `ghcr.io/producer-battle/*`. Auth is the workflow's own
   `GITHUB_TOKEN` (`packages: write`); no registry secret exists.
3. **migrate** - applies SQL migrations to the prod Postgres with Atlas
   (`atlas.hcl`, baseline-aware). Drizzle still authors the SQL +
   `src/db/schema.ts`; Atlas only owns the apply step. Skipped gracefully
   when `DATABASE_URL` isn't configured.
4. **k8s-deploy** - rolls the cluster Deployment to the new SHA:

   ```bash
   kubectl -n app set image deployment/api api=ghcr.io/producer-battle/prod-battle-api:<sha>
   kubectl -n app rollout status deployment/api --timeout=300s
   ```

   then smoke-tests `https://api-k8s.prodbattle.com/health` until it reports
   the just-shipped version. The job runs in the `production` GitHub
   environment and gracefully skips when the `KUBECONFIG` secret is absent.

Migrations are expected to be forward-compatible (additive columns/tables,
no drops the previous image still references): the old pods keep serving
during the rollout.

## Secrets

| Where | Name | Purpose |
|-------|------|---------|
| GH environment `production` | `KUBECONFIG` | Base64 (or raw) kubeconfig for the Kapsule cluster. Source: `tofu -chdir=envs/prod output -raw kubeconfig` in the infra repo. |
| GH repository | `DATABASE_URL` | Prod Postgres URL for the Atlas migrate job. |
| K8s Secret `app/api-secrets` | runtime credentials | DATABASE_URL, AUTH_SECRET, S3 keys, Mollie, OAuth, Discord, SMTP relay. Managed with kubectl only - intentionally NOT in Terraform state or GitHub. |

Non-secret runtime config (origins, S3 endpoint, SMTP host, ...) lives in
the `app/api-env` ConfigMap, managed by `modules/k8s-addons` in the infra
repo.

### Rotating a runtime secret

```bash
kubectl -n app edit secret api-secrets        # or patch a single key:
kubectl -n app patch secret api-secrets -p \
  '{"stringData":{"MOLLIE_API_KEY":"live_..."}}'
kubectl -n app rollout restart deployment/api  # pods read env at boot
```

## Manual deploy / rollback

Every push to `main` deploys automatically. To pin a specific build:

```bash
# any previously-built SHA tag works - list them on the ghcr package page
kubectl -n app set image deployment/api api=ghcr.io/producer-battle/prod-battle-api:<sha>
kubectl -n app rollout status deployment/api
```

Rollback is the same command with the previous SHA (`kubectl -n app
rollout undo deployment/api` also works for one step back).

## Observability

- Grafana: <https://grafana.prodbattle.com> (dashboard "Producer Battle /
  Overview"; admin password via `tofu output -raw grafana_admin_password`).
- Logs: Loki datasource in Grafana - `{namespace="app", pod=~"api-.*"}`.
- Metrics: the api exposes `/metrics` (prom-client), scraped pod-direct by
  the in-cluster Prometheus via a PodMonitor. The endpoint 404s any request
  carrying `X-Forwarded-For`, so it is not reachable through the ingress.
- Alerts: Alertmanager emails warning/critical to the ops inbox through the
  mail VM (SMTPS 465).

## Cluster topology (for orientation)

| Piece | Where | Managed by |
|-------|-------|------------|
| api Deployment (2 replicas) + Ingress | `app` namespace | infra repo `modules/k8s-addons` |
| Valkey (Redis-compatible) | `app` namespace StatefulSet | infra repo |
| ingress-nginx, cert-manager, kube-prometheus-stack, Loki, Promtail | helm releases | infra repo |
| Postgres 16 | Scaleway managed (HA) | infra repo `modules/data` |
| Mail (Mailu) | standalone VM | infra repo `modules/mail-server` |
| DNS / TLS | Cloudflare DNS + Let's Encrypt via cert-manager | infra repo |

`api.prodbattle.com` and `api-k8s.prodbattle.com` are the same backend; the
second exists as a stable hostname for CI smoke tests and DNS-cache
incidents.

## OpenAPI publish

On a GitHub Release, `publish-openapi` emits the spec and publishes
`@producer-battle/prod-battle-api` to GitHub Packages; the web repo pins a
version and regenerates its client via `@hey-api/openapi-ts`.
