# Remotely — operator runbook

Short, opinionated procedures for the things you need to do at 3am or once a quarter. Keep this file under version control; PR any changes.

## Secret rotation

Three long-lived secrets, plus database credentials. Rotate at least annually, and immediately on any suspected compromise or staff departure with access.

### `JWT_SECRET` (signs the web session cookie)

Effect of rotation: every signed-in user is logged out and must sign in again. Devices are unaffected — they auth via the device key, not the cookie.

1. Generate a new value:

   ```bash
   openssl rand -hex 32
   ```

2. Set it in your hosting environment (Vercel project settings → Environment Variables, Fly secrets, etc.).
3. Trigger a redeploy so all serverless functions pick up the new value.
4. Confirm: hit `/api/auth/me` with an old cookie — should return 401.

### `SIGNALING_SECRET` (signs short-lived signaling JWTs)

Effect of rotation: any in-flight WebSocket connection dies. Reconnects within ~5 seconds (client and viewer both auto-reconnect).

1. Generate a new value: `openssl rand -hex 32`
2. **Set on the signaling server first** (Fly: `fly secrets set SIGNALING_SECRET=...` then `fly deploy`).
3. **Then set on the web app** and redeploy.
4. Existing sessions will reconnect with fresh JWTs minted under the new secret.

Order matters because the web app mints JWTs that the signaling server validates; if you swap the web app first, all new JWTs will be rejected until the signaling server catches up.

### `TURN_SECRET` (HMAC key for short-lived TURN credentials)

Effect of rotation: in-flight WebRTC sessions continue (coturn keeps the allocation alive). New session starts within the next 5 minutes will fail until coturn is reloaded with the new secret.

1. Generate a new value: `openssl rand -hex 32`
2. Update `static-auth-secret=...` in `/etc/turnserver.conf` on the coturn VPS.
3. `sudo systemctl reload coturn` (or `sudo systemctl restart coturn` if reload doesn't pick it up).
4. Update `TURN_SECRET` in the web app's environment and redeploy.
5. Confirm with a fresh session — viewer should hit `/api/turn-credentials` and receive credentials that coturn accepts.

### Database credentials

If using Vercel Postgres or Neon, rotate via their dashboards. The application has a single `DATABASE_URL`; rotation is just: provision new credentials → update env var → redeploy → revoke old credentials.

## Forced sign-out (everyone)

Use case: suspected mass-credential compromise, or after rotating `JWT_SECRET`.

Rotating `JWT_SECRET` is the cleanest way to force every user to sign in again — old cookies become unverifiable. No code change needed.

## Force-rotate a single device key

Use case: a customer's laptop was stolen and they want the device unlinked.

1. The customer signs into the dashboard and deletes the device — this removes the row and invalidates the device key (the bcrypt hash is gone, so no future Bearer auth will succeed).
2. If the customer can't reach the dashboard, an operator can delete the row directly: `DELETE FROM "Device" WHERE id = '<id>';`.
3. Subsequent `/api/client/connect-token` requests from that device return 401.

## Reading the audit log

The `AuditLog` table is append-only. Tail recent events:

```sql
SELECT createdAt, action, userId, ip, targetId, metadata
FROM "AuditLog"
ORDER BY createdAt DESC
LIMIT 100;
```

Investigating a suspected account compromise:

```sql
SELECT * FROM "AuditLog"
WHERE userId = '<user-id>' OR metadata LIKE '%user@example.com%'
ORDER BY createdAt DESC;
```

After Wave 4 lands, rows will be hash-chained — any tampering will be visible via the `rowHash` / `prevHash` mismatch on the next daily root publication.

## Database backups

If using Vercel Postgres: automatic daily backups, 7 days retention on the free tier. Snapshots are restorable from the dashboard.

For self-hosted Postgres on Fly.io:

```bash
fly postgres backup list --app <db-app>
fly postgres backup create --app <db-app>
fly postgres backup restore <backup-id> --app <db-app>
```

Test restores at least once a year. A backup you've never restored is not a backup.

## coturn observability

```bash
# live connections
sudo turnadmin -L

# logs (default path; check turnserver.conf if customized)
sudo tail -f /var/log/coturn.log
```

Watch for "401 Unauthorized" — that means the web app and coturn disagree on the TURN secret (see rotation order above).

## Dependency hygiene

Renovate is configured in `/renovate.json`. It opens PRs every Monday with grouped patch/minor updates and auto-merges patch-only PRs once CI is green. To force an immediate vulnerability sweep, open the Dependency Dashboard issue in your repo and tick the "Check now" box.

Manual check:

```bash
cd web && npm audit
cd ../signaling && npm audit
cd ../client && npm audit
```

`npm audit fix` applies non-breaking fixes; review the diff before committing.
