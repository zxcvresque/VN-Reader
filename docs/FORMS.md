# Forms, Ground Work and the admin console

Everything here runs inside the existing `accounts` service and its SQLite database. No third-party form service is involved.

## Where things live

| Address | What it is |
|---|---|
| `/` | Home: a short introduction, then two paths, VN Reader and Ground Work |
| `/f/<form>` | A public form. Ground Work is `/f/groundwork` |
| `/go/<code>` | A custom share link (tracks where responses come from, can prefill answers) |
| `/admin` | The admin console. Separate from the reader; liquid glass by default |

The reader's logo now returns to the home page, including for signed-in readers.

## First run

1. Set `VN_ADMIN_EMAILS` to the owner's email (comma-separate several). Owners have every permission.
2. Deploy as usual: `docker compose up -d --build`.
3. Open `/admin` and sign in with that reader account.

The Ground Work form is created automatically on first start, rebuilt from the original SurveyHeart form: the same questions, split into four pages, with state and district added so responses can be viewed state by state. The group link is a setting of the form (Edit form → After submitting), never sent to a browser until that person's response is approved.

## Admin console

- **Responses**: search, filter by status, state, source link, any answer and date; choose columns; approve or reject one or many; notes; CSV and JSON export.
- **Statistics**: smart insights, responses over time, a state tile map, funnel from opening to approval, share-link performance, devices, time of day, and a chart per question.
- **Edit form**: question types (short and long text, number, email, phone, link, single and multiple choice, dropdown, yes/no, Indian state, rating, scale, date, time, consent, statement), pages, show-if conditions, skip-to-page rules, answer piping (`{{question}}`), validation, accent colour, fonts including an uploaded font, surface, backdrop and corner radius, schedule, response limit, one response per device or account.
- **Share**: custom links with prefilled answers and per-link statistics, QR codes (PNG and SVG).
- **Team and access**: owners add admins by email with any mix of permissions (view forms, edit forms, manage links, view, review, export and delete responses, view statistics, view reader activity, change settings, manage admins), optionally limited to specific forms. Every change is in the audit log.
- **Reader activity**: the previous in-reader admin dashboard (registrations, sign-ins, email allowance, media storage).
- **Backups and Telegram**: bot token, backup channel or group (and topic), switches for notifications.

## How applicants hear back

After submitting, the confirmation page offers three ways, all optional:

- **Telegram**: “Get updates” opens the bot with a one-time code. Pressing Start binds that response to that Telegram account. The bot then messages them on approval (with the group link as a button), and `/status` shows a person only the responses bound to their own account. Filling the form from inside the bot's web app binds automatically.
- **Email**: one email when the response is reviewed, sent through the existing SMTP setup and counted in `VN_EMAIL_DAILY_LIMIT`.
- **Private link**: a status link that works on any device. The secret part sits after `#`, which browsers do not send to servers.

The bot replies come from the archive service's existing Telegram bot (`TELEGRAM_BOT_TOKEN`), which asks the accounts service over the private Docker network (`VN_ACCOUNTS_URL`, default `http://accounts:3005`). Use the same bot token in the console so the web app button, backups and direct messages all come from one bot.

## Storage and backups

- **Primary**: SQLite, in the `account-data` volume.
- **R2**: every response is mirrored as JSON to a private bucket: `R2_FORMS_BUCKET`, under `R2_FORMS_PREFIX` (default `forms/`). The server refuses to use the public media bucket. Create a separate bucket with no public access and make sure the API token can write to it.
- **Telegram**: each new response, each decision, and on-demand full backups (JSON and CSV) go to the backup channel set in the console. The bot must be an admin of that channel.

Responses contain addresses and phone numbers. Keep the backup channel private and limit who has the export permission.

## Telegram web app

In Backups and Telegram, “Set web app button” makes the bot's menu button open `https://<your domain>/`, so the whole site, including forms, works inside Telegram.
