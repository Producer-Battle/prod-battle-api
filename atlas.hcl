# Atlas migration config.
#
# Atlas owns migration application and CI linting; drizzle-kit stays for
# schema definition (src/db/schema.ts) and for `pnpm db:generate` which
# produces new SQL files from schema diffs (atlas reads those files
# verbatim, no journal involvement).
#
# Tracking table is `atlas_schema_revisions` (Atlas-managed). The legacy
# `__drizzle_migrations` table remains in prod but is no longer written
# to. To roll back: revert the .github/workflows/deploy.yml change and
# restore `pnpm db:migrate` as the apply step.

# `external_schema` reads the drizzle TypeScript schema and emits SQL,
# which atlas uses as the *desired* state for `atlas migrate diff` (the
# command developers run locally to generate a new migration file).
data "external_schema" "drizzle" {
  program = [
    "pnpm",
    "drizzle-kit",
    "export",
  ]
}

env "prod" {
  src = data.external_schema.drizzle.url
  url = getenv("DATABASE_URL")
  # `dev` is a throwaway DB atlas uses for migration diffing/linting. The
  # GitHub Action provisions one automatically when omitted; locally,
  # docker-compose's postgres exposes 5433 (per modules/docker-compose.yml).
  dev = getenv("ATLAS_DEV_URL")

  migration {
    dir = "file://src/db/migrations"
    # Baseline = the last drizzle-applied migration version in prod
    # (just the numeric prefix - atlas parses our drizzle filenames as
    # <version>_<description>.sql). On first `atlas migrate apply`
    # against a DB without atlas_schema_revisions, Atlas inserts a
    # synthetic revision marking everything up through this version as
    # already applied. Without this, atlas would try to re-run every
    # migration from 0000 - unsafe even with the idempotency guards
    # most of our migrations have.
    baseline = "0038"
  }

  format {
    migrate {
      diff = "{{ sql . \"  \" }}"
    }
  }
}
