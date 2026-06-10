# Nightly Postgres backup image for the postgres-backup CronJob
# (prod-battle-infra modules/k8s-addons). Runs:
#   pg_dump | gzip | age -r $AGE_RECIPIENT | aws s3 cp - s3://...
#
# Pinned to postgresql16-client to match the managed Postgres 16 server -
# pg_dump must not be older than the server major version.
FROM alpine:3.21

RUN apk add --no-cache \
      postgresql16-client \
      aws-cli \
      age \
      gzip \
      coreutils

# Sanity: every binary the CronJob's shell script needs must exist.
RUN command -v pg_dump && command -v aws && command -v age && command -v gzip

# The CronJob supplies the command; default to a no-op help text so a bare
# `docker run` doesn't silently dump anything.
CMD ["sh", "-c", "echo 'pg-backup image: supply a command (see postgres-backup CronJob in prod-battle-infra)'"]
