# Email sign-in

Civic Spark uses email links for both signup and returning sign-in. Enter an email address and an optional name, receive a link, and open it to verify the address and sign in. Links expire after 10 minutes and work once. A returning user gets the same account and memberships. No password or Google/Apple app registration is needed.

Better Auth manages verification and database-backed sessions. The database stores a hash of each login token. The request endpoint returns only success, never the link. Event roles and workspace ownership use the stable internal user ID; email identifies the account at sign-in and when an admin adds another registered account. [Better Auth magic links](https://better-auth.com/docs/plugins/magic-link)

## Configure a sender

Set `BETTER_AUTH_URL` to the exact browser origin, such as `http://127.0.0.1:4310` locally or `https://event.example.org` when hosted. Links point there. Put credentials in the ignored `.env` file locally or the deployment's secret manager, then restart the server. Never prefix secrets with `VITE_`.

Choose one adapter with `CIVIC_SPARK_EMAIL_PROVIDER`. The default, `disabled`, displays an unavailable message and rejects requests to send links. Selecting a provider with incomplete configuration fails startup with the missing setting's name. Email mode has no unverified sign-in path or console-link delivery mode. The explicitly selected local prototype mode below is separate.

### Standard SMTP: Brevo or another mail service

```dotenv
CIVIC_SPARK_EMAIL_PROVIDER=smtp
CIVIC_SPARK_EMAIL_FROM=Civic Spark <signin@your-domain.example>
SMTP_HOST=your-provider-smtp-host
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-provider-smtp-login
SMTP_PASSWORD=your-provider-smtp-key
```

Use the credentials and server address from your provider's transactional SMTP settings. Verify the sender address/domain as the provider requires. Port 587 uses mandatory STARTTLS; port 465 defaults to immediate TLS. Certificate verification remains enabled. [Nodemailer SMTP](https://nodemailer.com/smtp)

### Resend HTTP API

```dotenv
CIVIC_SPARK_EMAIL_PROVIDER=resend
CIVIC_SPARK_EMAIL_FROM=Civic Spark <signin@your-domain.example>
RESEND_API_KEY=your-api-key
```

Verify your sender domain in Resend and create a sending API key. This adapter uses Resend's HTTPS API and does not require SMTP settings. [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email)

## Free options and Fly

Checked September 15, 2026:

| Service | Free allowance | Civic Spark adapter |
| --- | --- | --- |
| Brevo | 300 emails/day, including transactional mail | SMTP |
| Resend | 3,000 emails/month, limited to 100/day | Resend API |

For around 40 attendees, Brevo gives more room for retries and repeat sign-ins on the event day. Resend is also enough for an initial login by each person. Brevo's free plan includes its branding. Check the provider's quota before the event: delayed delivery can outlast the 10-minute link lifetime. [Brevo free plan](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan), [Resend pricing](https://resend.com/pricing)

Fly's documentation recommends an external transactional sender such as Resend or Postmark. Civic Spark uses Fly for the app, with outbound SMTP or HTTPS to the chosen sender; email delivery has no Fly-specific dependency. [Fly SMTP guidance](https://fly.io/docs/getting-started/troubleshooting/)

## Adapter boundary

`apps/server/src/email.ts` implements `EmailDelivery`: a `configured` flag and asynchronous `send({ email, url })` operation. Provider choice and credentials are installation settings. Changing providers does not change accounts, sessions, event roles, or workspace access. Add another API adapter there without changing the sign-in flow. Automated tests inject an in-memory mailbox; the application exposes no test mailbox route.

Delivery errors are sanitized before reaching auth logs or browser responses. Do not log email bodies or full verification URLs, including in reverse-proxy access logs: those URLs contain login credentials. A successful send means the provider accepted the message, not that inbox delivery is proven.

## Sessions, rate limits, and permissions

- Unauthenticated users see sign-in and receive 401 for application data APIs.
- Only verified-email sessions authorize data access. Cookies are HttpOnly and secure when the configured origin is HTTPS.
- Sessions last up to seven days and refresh during use; sign-out revokes the database session.
- CSRF/origin checks protect writes. Verification rejects redirects outside the configured trusted origin.
- Auth responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- Magic-link requests and verification are limited per IP/path, default 120 requests per minute, to accommodate attendees sharing Wi-Fi. Set `CIVIC_SPARK_AUTH_REQUESTS_PER_MINUTE` to tune that limit. These request limits do not enforce a daily email budget.
- The server replaces any caller-supplied IP hint. A deployed proxy needs explicit trusted-proxy configuration to identify the real client IP; the local Vite proxy sees loopback.

Event creators become admins. Admins can promote members or add an already signed-in account by verified email without team membership. Adding an admin never creates an account or sends an invitation. Each user/team membership owns a separate checkout/Sprite. Admins cannot browse others' private files. Membership removal revokes access and preserves files; rejoining while registration is open restores the workspace.

## Verification status

Automated integration tests exercise actual link issuance, verification, hashed storage, expiry, replay rejection, logout, returning identity, redirect validation, and delivery failure. Browser tests complete signup through a test-only mailbox, then exercise the event/team/workspace flow. Adapter tests cover provider acceptance/rejection and required SMTP encryption.

No live sender is configured yet. Before using this at an event, configure the chosen service and verify real inbox delivery and sign-in on the deployed origin. External delivery has not been claimed as tested.

## Local prototype mode

The user explicitly requested email identity without verification for UI prototyping. Set `CIVIC_SPARK_AUTH_MODE=prototype`, restart, and enter an email. A normalized lowercase email is the domain identity; real signed session cookies retain that selection. No email is sent. Signing in with the same email returns to its prototype teams and admin roles.

This mode is loopback-only, uses a separate `civic-spark-prototype` cookie prefix and a `prototype/` subdirectory under the data directory, and displays a prototype label. Its `/api/prototype/sign-in` endpoint exists only in that mode. Anyone with local access can select any prototype email; it is not email verification. The standard auth store and verified-email mode remain separate. Switching back to `email` removes the prototype entry path and does not import prototype accounts.
