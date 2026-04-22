# Deployment Guide

## Pipeline Overview

The deploy workflow (`.github/workflows/deploy.yml`) runs on two triggers and maps to two environments:

| Git event | Environment | Image tags | OpenAPI publish |
|-----------|-------------|------------|-----------------|
| Push to `main` | staging | `staging-<short-sha>`, `staging-latest` | No |
| GitHub Release published | prod | `<release-tag>` (e.g. `v0.1.0`), `prod-latest` | Yes |

### Jobs

1. **meta** — Runs first; computes the environment name and image tags, then exposes them as outputs for downstream jobs.
2. **build** — Logs into Scaleway Container Registry and pushes both the API image and the `ffmpeg` job image.
3. **redeploy** — Calls the Scaleway API to tell the running Serverless Container to pull the new image. The prod redeploy is skipped silently if `SCW_CONTAINER_ID_PROD` has not been set yet.
4. **publish-openapi** — Prod releases only. Generates the OpenAPI spec and publishes it as `@producer-battle/prod-battle-api` to GitHub Packages.

The `build` job has no pnpm/Node setup steps — it only builds the Docker image (Node runs inside the image). `publish-openapi` is the only job that installs Node dependencies on the runner.

---

## Secrets

All secrets are set at the **repository** level in GitHub (`Settings → Secrets and variables → Actions`).

### Required secrets

| Secret name | Value | Notes |
|-------------|-------|-------|
| `SCW_SECRET_KEY` | Your Scaleway API key secret | Used for both registry login and the Containers API. Obtain from Scaleway console → IAM → API Keys. |
| `SCW_CONTAINER_ID_STAGING` | `59fbe610-4ecc-4052-9cd2-f0da59c25edc` | The UUID of the `prod-battle-staging-api` Serverless Container in `fr-par`. |
| `SCW_CONTAINER_ID_PROD` | Set once prod is provisioned | Leave unset until prod infrastructure exists — the workflow skips the prod redeploy gracefully. |

`GITHUB_TOKEN` is provided automatically by Actions with `packages: write` — no additional secret is needed for publishing to GitHub Packages.

`SCW_REGISTRY_USER` does **not** need to be stored as a secret. Scaleway's registry accepts any non-empty string as the username when authenticating with a secret key; the workflow hardcodes `nologin`.

### Finding the container ID

Three equivalent methods:

**a) Scaleway CLI:**
```bash
scw container container list region=fr-par name=prod-battle-staging-api
```
The `ID` column is the UUID.

**b) OpenTofu state (infra repo):**
```bash
cd /path/to/prod-battle-infra
tofu state show 'scaleway_container.api'
# look for the `id` attribute
```

**c) Scaleway console:**
Navigate to Containers → `prod-battle-staging-api-ns` → `prod-battle-staging-api` → Settings. The container ID appears in the URL: `.../containers/<uuid>/...`.

### `gh secret set` commands

Run these once from the repo root (requires `gh` CLI authenticated as a repo admin):

```bash
# Scaleway API key — paste the secret key value when prompted
gh secret set SCW_SECRET_KEY

# Staging container ID (already known)
gh secret set SCW_CONTAINER_ID_STAGING --body "59fbe610-4ecc-4052-9cd2-f0da59c25edc"

# Prod container ID — set after prod infra is provisioned
# gh secret set SCW_CONTAINER_ID_PROD --body "<prod-container-uuid>"
```

---

## Creating a production release

1. Ensure all changes are merged to `main` and CI is green.
2. Tag and create a GitHub Release:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
   Then open GitHub → Releases → "Draft a new release", select `v0.1.0`, fill in release notes, and click **Publish release**. This triggers the `release: [published]` event.

   Alternatively with `gh`:
   ```bash
   gh release create v0.1.0 --title "v0.1.0" --notes "Initial release"
   ```

---

## Manual deploy (when CI is broken)

If the pipeline is down and you need to ship a fix manually, run these steps locally. You need Docker, `curl`, and a Scaleway secret key with Container Registry and Containers API access.

```bash
export SCW_SECRET_KEY="<your-scaleway-secret-key>"
export REGISTRY="rg.fr-par.scw.cloud/prod-battle-staging-registry"
export IMAGE_NAME="prod-battle-api"
export TAG="manual-$(git rev-parse --short HEAD)"
export CONTAINER_ID="59fbe610-4ecc-4052-9cd2-f0da59c25edc"

# 1. Build the image
docker build --tag "${REGISTRY}/${IMAGE_NAME}:${TAG}" .

# 2. Log in to the registry
echo "${SCW_SECRET_KEY}" | docker login rg.fr-par.scw.cloud \
  --username nologin --password-stdin

# 3. Push the image
docker push "${REGISTRY}/${IMAGE_NAME}:${TAG}"

# Also push the secondary tag if desired
docker tag "${REGISTRY}/${IMAGE_NAME}:${TAG}" \
            "${REGISTRY}/${IMAGE_NAME}:staging-latest"
docker push "${REGISTRY}/${IMAGE_NAME}:staging-latest"

# 4. Redeploy the Scaleway Serverless Container
curl --fail-with-body \
  --request PATCH \
  --header "X-Auth-Token: ${SCW_SECRET_KEY}" \
  --header "Content-Type: application/json" \
  --data '{"redeploy": true}' \
  "https://api.scaleway.com/containers/v1beta1/regions/fr-par/containers/${CONTAINER_ID}"
```

For the ffmpeg job image, repeat steps 1–3 substituting `context: ./jobs/ffmpeg` and image name `prod-battle-api-ffmpeg`.

### Verifying the redeploy

After the `curl` call returns HTTP 200, the container transitions to `redeploying` status. Poll until it is `ready`:

```bash
curl --silent \
  --header "X-Auth-Token: ${SCW_SECRET_KEY}" \
  "https://api.scaleway.com/containers/v1beta1/regions/fr-par/containers/${CONTAINER_ID}" \
  | jq '{status: .status, image_uri: .registry_image}'
```
