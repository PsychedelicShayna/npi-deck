-- Webhook deliveries are signed: X-Routine-Signature carries
-- sha256=<hex HMAC-SHA256(secret, "<X-Routine-Timestamp>.<raw body>")>.
-- Computing that MAC needs the secret itself, so the deck now keeps it as
-- `signing_key` next to the sha256 `secret_hash`.
--
-- Registrations made before this migration only have the hash, and their
-- senders put the bare secret in X-Routine-Signature. They keep working:
-- `accept_bare_secret` is set on every existing row. The first bare-secret
-- delivery stores the (hash-verified) secret as `signing_key`, so the same
-- sender can switch to signed deliveries without a rotation. New and rotated
-- secrets never accept the bare secret.
ALTER TABLE routine_webhook_secrets ADD COLUMN signing_key TEXT;
ALTER TABLE routine_webhook_secrets ADD COLUMN accept_bare_secret INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routine_webhook_secrets ADD COLUMN last_bare_secret_at TEXT;
UPDATE routine_webhook_secrets SET accept_bare_secret = 1;
