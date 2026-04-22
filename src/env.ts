import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),

  // Connection strings, not validated as URLs: WHATWG URL parsing rejects
  // passwords containing `#` or `%`, which the auto-generated credentials
  // from the tofu `random_password` resource do include.
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),

  S3_ENDPOINT: z.string().url().optional(),
  // URL base used when returning public stem/zip URLs to clients. Defaults
  // to S3_ENDPOINT. In compose, S3_ENDPOINT=http://minio:9000 (internal)
  // while S3_PUBLIC_ENDPOINT=http://localhost:9002 (browser-reachable).
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),

  SCW_JOB_FFMPEG_ID: z.string().optional(),
  SCW_ACCESS_KEY: z.string().optional(),
  SCW_SECRET_KEY: z.string().optional(),
  SCW_PROJECT_ID: z.string().optional(),

  AUTH_SECRET: z.string().min(32).optional(),
  // Comma-separated list of trusted origins (see server.ts). Kept as a
  // plain string — validating each entry as a URL is the caller's job.
  AUTH_TRUSTED_ORIGINS: z.string().optional(),
  WEB_ORIGIN: z.string().optional(),

  // Public-facing base URL of this API. Used by better-auth for cookie
  // domain + OAuth redirect URLs. In prod: https://api.prodbattle.com.
  // In local dev defaults to http://localhost:8080.
  AUTH_BASE_URL: z.string().optional(),

  // Google OAuth — optional. If unset, the Google sign-in button on the
  // web is still rendered but the `/auth/callback/google` endpoint returns
  // 503 "google_oauth_not_configured". Setting both enables the provider.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),

  // Freesound.org APIv2 token - register at https://freesound.org/apiv2/apply/
  FREESOUND_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);
