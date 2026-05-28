-- Recurring subscription support for the Supporter tier. The original billing
-- flow was one-time (pay once, plan='paid' forever). These columns let us
-- track a real Mollie recurring subscription:
--   mollie_subscription_id - the sub_xxx we create after the first payment
--   subscription_status    - active | canceled | expired (null = none)
--   plan_expires_at        - end of the currently-paid period; the expiration
--                            cron demotes to 'free' once this passes and the
--                            subscription is no longer active.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mollie_subscription_id text,
  ADD COLUMN IF NOT EXISTS subscription_status text,
  ADD COLUMN IF NOT EXISTS plan_expires_at timestamptz;
