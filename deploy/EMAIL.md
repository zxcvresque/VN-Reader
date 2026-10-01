# Email/password login and device sync

Better Auth runs in the `accounts` container on Oracle. It already supports email/password signup, six-digit verification codes, password reset, and persistent sessions. Your SMTP service only delivers email. Account data stays in the `account-data` volume; the Telegram archive stays separate.

## Choose a delivery service

For 400+ new accounts/day, choose a relay with sufficient sending quota. Count verification resends and password-reset messages too. Ordinary password sign-in does not send an email.

Amazon SES is a low-cost option. Its [à-la-carte sending price](https://aws.amazon.com/ses/pricing/) is $0.10/1,000 messages; new accounts may start on Essentials ($0.16/1,000), and AWS documents switching to à-la-carte. At 400 messages/day for 30 days, the base à-la-carte charge is about $1.20, before tax, transfer and optional extras. Prices checked October 1, 2026. The [sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) initially allows only verified recipients and 200 messages/24 hours, so production approval and a sufficient quota are required before public signup.

[Brevo Free](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans) allows 300 emails/day. It is useful for initial testing but does not cover 400 daily signups.

Self-hosting SMTP is possible, but first confirm Oracle will permit direct delivery: [outbound TCP port 25 is blocked by default](https://docs.oracle.com/en-us/iaas/releasenotes/changes/f7e95770-9844-43db-916c-6ccbaf2cfe24/) for newer tenancies. A direct mail server also needs working reverse DNS, SPF/DKIM/DMARC, queue monitoring, bounce handling and ongoing reputation management. Cloudflare Tunnel publishes the website; it does not replace outbound SMTP delivery.

## Brevo setup for the initial launch

1. Create a free account at [Brevo](https://www.brevo.com/). In **Settings → Senders, Domains, IPs → Domains**, add `vidurneeti.xyz`.
2. Choose manual domain authentication and add the exact Brevo verification, DKIM and DMARC records to Cloudflare. Keep DKIM CNAMEs DNS only. If a DMARC record already exists, review/update that one instead of creating a duplicate. Follow [Brevo's domain guide](https://help.brevo.com/hc/en-us/articles/12163873383186-Authenticate-your-domain-with-Brevo-Brevo-code-DKIM-DMARC); its domain setup screens may vary.
3. Add a transactional sender **VN Reader**, `noreply@vidurneeti.xyz`, using the authenticated domain. Complete any sender verification or transactional activation Brevo requires.
4. Open **SMTP & API → SMTP**, copy the displayed SMTP login and generate an SMTP key for VN Reader. Use the SMTP key as password, not an API key or your Brevo account password. [Brevo SMTP guide](https://help.brevo.com/hc/en-us/articles/7924908994450-Send-transactional-emails-using-Brevo-SMTP).
5. Follow the VPS steps below, using `VN_SMTP_HOST=smtp-relay.brevo.com`, port `587`, your displayed SMTP login and SMTP key. Better Auth supplies the code email text; you do not need Brevo automations or templates.
6. Test signup, OTP delivery, password reset and device sync. Monitor **Transactional → Logs**. At the free daily limit, transactional mail can be queued; a verification code can expire before delayed delivery. Upgrade or switch the SMTP relay before traffic exceeds that allowance.

## Amazon SES setup

1. Open Amazon SES in a chosen supported region and keep that region consistent for the domain, endpoint and credentials.
2. Create a **Domain identity** for `vidurneeti.xyz` with Easy DKIM. Add SES's exact DNS records to Cloudflare. DKIM CNAME records must be **DNS only**, not proxied. Wait for the identity to become Verified. Use [AWS's domain verification instructions](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html).
3. Follow AWS's custom MAIL FROM instructions if enabling it: use a separate subdomain such as `mail.vidurneeti.xyz`, add its supplied MX/SPF records and the appropriate domain DMARC record. Preserve existing mail records; do not add a second SPF record at the same name.
4. Request **Production access**, with Transactional email, the website URL and an accurate description: users request verification or password-reset codes; no purchased lists or marketing. Explain your bounce/complaint handling and request a quota that covers expected signups and resends. Configure SES bounce/complaint notifications or your supported event handling before public launch. Do not claim those are handled by VN Reader.
5. Under **SMTP settings → Create SMTP credentials**, create credentials for this application and store them privately. SES SMTP credentials are region-specific and the SMTP password differs from an AWS secret access key. [AWS's SMTP guide](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html).

## Connect the existing Oracle deployment

On the VPS, in `~/vn-reader`:

```sh
nano .env.production
```

Set the existing SMTP entries using the endpoint and credentials shown by your provider:

```dotenv
VN_SMTP_HOST=YOUR_REGION_SMTP_ENDPOINT
VN_SMTP_PORT=587
VN_SMTP_USERNAME=YOUR_SMTP_USERNAME
VN_SMTP_PASSWORD='YOUR_SMTP_PASSWORD'
VN_SMTP_FROM='VN Reader <noreply@vidurneeti.xyz>'
VN_SMTP_SSL=false
```

Keep `VN_DOMAIN=vidurneeti.xyz` and your existing `BETTER_AUTH_SECRET` unchanged. Wrap values containing `$` or `#` in single quotes. Never commit `.env.production` or share screenshots containing credentials. Port 587 uses STARTTLS; `false` here means STARTTLS rather than implicit TLS, not unencrypted delivery.

```sh
chmod 600 .env.production
dc up -d --force-recreate accounts
dc ps
curl -fsS https://vidurneeti.xyz/api/config
```

`accountsEnabled: true` means SMTP settings exist, not proof an inbox received email. Refresh the website, create an account with an email you control and a password of at least 12 characters, then enter the six-digit inbox code. The code expires in 10 minutes. In the SES sandbox, verify that recipient first. Check spam and provider sending status if it does not arrive.

## Verify sync with two devices

1. On device A, verify and sign in. Save a note and bookmark, set a post to In progress and read partway into it. Wait for **Saved across devices**.
2. On device B, sign in with the same email/password. Confirm the note, bookmark, reading state and position are restored. Change a different note and wait for saving.
3. Return to A. The app checks for changes every 15 seconds, and on return to the tab; **Sync now** is also available in the account panel. Confirm B's change arrived.
4. Test another account: it must not see the first account's personal data. Sign out and confirm the separate browser guest copy is restored.
5. Test Forgot password and sign in with the new password. A password reset revokes previous sessions.

Synced data includes reading positions and seen/finished states, bookmarks, notes, saved passages, collections, read-later order, media playback memory and appearance preferences. The transient Back/Forward navigation trail remains local to the current session. Concurrent edits to the same field require an explicit choice; the account panel shows conflicts instead of silently overwriting. Offline changes stay in an account-specific device cache and retry when online. Guest data is imported only when the reader chooses it.

Keep the persistent account volume and authentication secret backed up. Login does not make Telegram the storage for users' passwords or personal notes. Automated tests cover OTP verification/reset, two HTTP sessions sharing state, account isolation and sync conflict handling; real inbox delivery and a two-physical-device test must be completed after SMTP is connected.
