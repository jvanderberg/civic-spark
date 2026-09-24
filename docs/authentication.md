# Email sign-in

Civic Spark uses email for both signup and returning sign-in. Enter an email address and an optional name, and one email arrives with a six-digit code and a link. Type the code in the tab that asked for it, or open the link. Both verify the address and sign in, expire after 10 minutes and work once. Following the link cancels the code sent with it, and a newer email replaces the previous code. Five incorrect codes discard it. A returning user gets the same account and memberships. No password or Google/Apple app registration is needed.

The code exists for phones: mail apps often open links in their own browser, which would sign in there instead of the tab the person started in.

Better Auth manages verification and database-backed sessions. The database stores hashes of each link token and code. The request endpoint returns only success, never the link or code. Only `/api/auth/sign-in/email-otp` is reachable from the code plugin; its standalone send, check, password-reset and email-change routes return 404. Event roles and workspace ownership use the stable internal user ID; email identifies the account at sign-in and when an admin adds another registered account. [Better Auth magic links](https://better-auth.com/docs/plugins/magic-link), [email OTP](https://better-auth.com/docs/plugins/email-otp)

## Configure a sender

Set `BETTER_AUTH_URL` to the exact browser origin, such as `http://127.0.0.1:4310` locally or `https://event.example.org` when hosted. Links point there. Put credentials in the ignored `.env` file locally or the deployment's secret manager, then restart the server. Never prefix secrets with `VITE_`.

Choose one adapter with `CIVIC_SPARK_EMAIL_PROVIDER`. The default, `disabled`, displays an unavailable message and rejects requests to send links. Selecting a provider with incomplete configuration fails startup with the missing setting's name. Email mode has no unverified sign-in path or console-link delivery mode. The explicitly selected local prototype mode below is separate.

### Gmail (recommended without a domain)

A dedicated Gmail account sends through Google's servers with Google's signatures, so messages pass SPF, DKIM and DMARC without any domain of your own. Nobody replies to sign-in email, so a generic address such as `civicspark.signin@gmail.com` is enough.

1. Create the account and turn on 2-Step Verification.
2. Create an app password at <https://myaccount.google.com/apppasswords>. It is 16 letters; spaces are ignored.
3. Use the account address as `emailFrom` and `SMTP_USER`.

```dotenv
CIVIC_SPARK_EMAIL_PROVIDER=smtp
CIVIC_SPARK_EMAIL_FROM=Civic Spark <civicspark.signin@gmail.com>
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=civicspark.signin@gmail.com
SMTP_PASSWORD=your-app-password
```

The Fly setup's `gmail` preset writes these settings. Sending "from" a Gmail address through another provider fails DMARC and lands in spam; send through Gmail itself. [Google app passwords](https://support.google.com/accounts/answer/185833)

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

Checked September 15, 2026; Gmail added September 23, 2026:

| Service | Free allowance | Needs your own domain | Civic Spark adapter |
| --- | --- | --- | --- |
| Gmail | About 500 recipients/day | No | SMTP (`gmail` setup preset) |
| Brevo | 300 emails/day, including transactional mail | Yes, for reliable inbox delivery | SMTP |
| Resend | 3,000 emails/month, limited to 100/day | Yes | Resend API |

Without a domain, use Gmail. With a domain and SPF/DKIM/DMARC records, Resend or Brevo also work. For around 40 attendees each allowance covers sign-in with retries; sessions last a week, so most people sign in once. Brevo's free plan includes its branding. Check the provider's quota before the event: delayed delivery can outlast the 10-minute code lifetime. [Gmail sending limits](https://support.google.com/a/answer/166852) [Brevo free plan](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan), [Resend pricing](https://resend.com/pricing)

Fly's documentation recommends an external transactional sender such as Resend or Postmark. Civic Spark uses Fly for the app, with outbound SMTP or HTTPS to the chosen sender; email delivery has no Fly-specific dependency. [Fly SMTP guidance](https://fly.io/docs/getting-started/troubleshooting/)

## Adapter boundary

`apps/server/src/email.ts` implements `EmailDelivery`: a `configured` flag and asynchronous `send({ email, url, code })` operation. Provider choice and credentials are installation settings. Changing providers does not change accounts, sessions, event roles, or workspace access. Add another API adapter there without changing the sign-in flow. Automated tests inject an in-memory mailbox; the application exposes no test mailbox route.

Delivery errors are sanitized before reaching auth logs or browser responses. Do not log email bodies, subjects or full verification URLs, including in reverse-proxy access logs: they contain login credentials. The subject carries the code so it shows in phone notifications. A successful send means the provider accepted the message, not that inbox delivery is proven.

## Sessions, rate limits, and permissions

- Unauthenticated users see sign-in and receive 401 for application data APIs.
- Only verified-email sessions authorize data access. Cookies are HttpOnly and secure when the configured origin is HTTPS.
- Sessions last up to seven days and refresh during use; sign-out revokes the database session.
- CSRF/origin checks protect writes. Verification rejects redirects outside the configured trusted origin.
- Auth responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- Link requests, link verification and code entry are limited per IP/path, default 120 requests per minute, to accommodate attendees sharing Wi-Fi. Set `CIVIC_SPARK_AUTH_REQUESTS_PER_MINUTE` to tune that limit. These request limits do not enforce a daily email budget.
- The server replaces any caller-supplied IP hint. A deployed proxy needs explicit trusted-proxy configuration to identify the real client IP; the local Vite proxy sees loopback.

Event creators become admins. Admins can promote members or add an already signed-in account by verified email without team membership. Adding an admin never creates an account or sends an invitation. Each user/team membership owns a separate checkout/Sprite. Admins cannot browse others' private files. Membership removal revokes access and preserves files; rejoining while registration is open restores the workspace.

## Verification status

Automated integration tests exercise actual link and code issuance, verification, hashed storage, expiry, replay rejection, code replacement, link-cancels-code, the attempt limit, blocked code routes, logout, returning identity, redirect validation, and delivery failure. Browser tests complete signup through a test-only mailbox by link and by code, including code entry at phone, desktop and short viewports in both themes. Adapter and setup tests cover provider acceptance/rejection, required SMTP encryption and the Gmail preset.

No live sender is configured yet. Before using this at an event, configure the chosen service, run the setup's `test-email` action, and verify real inbox delivery and sign-in on the deployed origin, including on a phone. External delivery has not been claimed as tested.

## Local prototype mode

The user explicitly requested email identity without verification for UI prototyping. Set `CIVIC_SPARK_AUTH_MODE=prototype`, restart, and enter an email. A normalized lowercase email is the domain identity; real signed session cookies retain that selection. No email is sent. Signing in with the same email returns to its prototype teams and admin roles.

This mode is loopback-only, uses a separate `civic-spark-prototype` cookie prefix and a `prototype/` subdirectory under the data directory, and displays a prototype label. Its `/api/prototype/sign-in` endpoint exists only in that mode. Anyone with local access can select any prototype email; it is not email verification. The standard auth store and verified-email mode remain separate. Switching back to `email` removes the prototype entry path and does not import prototype accounts.

## Explicit hosted demo mode

`CIVIC_SPARK_AUTH_MODE=demo` enables visibly unverified email entry on a fresh demo installation, including HTTPS hosting without SMTP/Resend. Anyone entering the same email can access that demo account. Demo identities remain `emailVerified: false`, explicitly marked as demo, with a separate `demo/` data directory and `civic-spark-demo` cookie prefix. They never authorize verified-email production mode or migrate automatically. Local prototype restrictions remain unchanged.

`/api/demo/sign-in` checks a per-client limiter before writing users or sessions, using the server's normalized client IP. The default budget is 20 requests/minute, configurable via `CIVIC_SPARK_AUTH_REQUESTS_PER_MINUTE`. Fixed-window entries expire after a minute; the process-local map is capped at 10,000 clients and resets on restart. This throttles requests; it is not a lifetime data quota. Use only demo data and remove disposable model credentials after rehearsals. See [demo deployment](fly-deployment.md#explicit-hosted-demo).
