# Oracle A1 deployment at vidurneeti.xyz

Everything runs on the Oracle A1 VPS: the React website, Better Auth, the archive/media API and the continuously connected Telegram mirror. Cloudflare Tunnel connects `https://vidurneeti.xyz` to the private `web:80` container. The Compose files publish **no host ports**; you do not need Oracle ingress rules for ports 80 or 443.

Telegram stores the copied archive and media. Persistent Docker volumes store the archive index/checkpoints, Telegram sessions, accounts, password hashes, sessions and reading progress. These databases are necessary: Telegram is not a transactional authentication database. No media library is downloaded to the VPS; requested media passes through its streaming API. The tunnel is a route to the VPS, not a separate hosting platform.

## 1. Prepare Cloudflare

1. Add `vidurneeti.xyz` to your Cloudflare account and change the registrar nameservers to the nameservers Cloudflare gives you. Wait until the zone is Active.
2. Open Cloudflare Dashboard → Networking → Tunnels (or Zero Trust → Networks → Connectors / Tunnels in the older dashboard). Create a **Cloudflared**, remotely managed tunnel named `vn-reader-oracle`.
3. Choose Docker. Keep the tunnel token from the displayed connector command private. Use **only the token value**, not the whole command, when saving the token file below.
4. Add a published application route / public hostname:
   - Subdomain: leave empty.
   - Domain: `vidurneeti.xyz`.
   - Path: leave empty.
   - Service type: **HTTP**.
   - Service URL: **`web:80`**.
5. Cloudflare creates the tunnel DNS record. Remove a conflicting existing A/AAAA/CNAME for the same hostname if the dashboard refuses to create it. Do not point the root domain to the VPS IP as well.
6. Enable **Always Use HTTPS** for the zone. Leave the reader public; a Cloudflare Access login in front of the site is unnecessary because the app already supports guests and Better Auth.
7. Keep `/api/*` excluded from any custom “Cache Everything” rule. Auth, saved state and streamed media are not cached by this deployment. Do not enable email-obfuscation or HTML rewriting for the application without testing.

Cloudflare documents [dashboard tunnel setup](https://developers.cloudflare.com/tunnel/get-started/), [public hostname routing](https://developers.cloudflare.com/tunnel/concepts/routing/) and [the token-file option](https://developers.cloudflare.com/tunnel/reference/run-parameters/#token-file). The connector makes [outbound connections on TCP/UDP **7844**](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/) if your VPS egress firewall is restricted. Telegram, image downloads during builds and SMTP also need their normal outbound connectivity.

## 2. Stop the local mirror and make the migration bundle

On your Mac, stop the terminal running the Telegram mirror with **Ctrl+C**. Wait until it exits. Do not run a second mirror with the same session while migrating. The helper refuses an active mirror lock and uses SQLite's backup API to take consistent snapshots.

```sh
cd "/Users/vr/Code-space/VN Reader"
python3 scripts/prepare-vps-migration.py --env-file server/.env --output data/vps-migration.tar.gz
```

This creates a private bundle containing the existing archive mapping/checkpoint database, authorized reader session, available bot sessions and any existing account database. Credentials and the environment file are **not** included. Migrating this database preserves the completed backfill and reply mappings; do not start a fresh backfill.

Existing browser-only guest progress remains in the original browser. Users can export a reading-state backup and import it on the deployed site, then sign in to sync it.

## 3. Copy the project and private files

Replace `VPS_IP` with your Oracle instance IP. These examples assume the Oracle Ubuntu user `ubuntu`; use your actual SSH username/key if different.

On the VPS (skip `git clone` if you already have this checkout):

```sh
cd ~
git clone https://github.com/zxcvresque/VN-Reader.git vn-reader
cd ~/vn-reader
mkdir -p data deploy/secrets
chmod 700 deploy/secrets
```

For an existing clean checkout, update with `git pull --ff-only` from `~/vn-reader`.
If the repository is private, authenticate GitHub on the VPS first; do not embed an access token in the clone URL.

On your Mac, transfer only the private runtime files:

```sh
cd "/Users/vr/Code-space/VN Reader"
scp data/vps-migration.tar.gz ubuntu@VPS_IP:~/vn-reader/data/
scp server/.env ubuntu@VPS_IP:~/vn-reader/.env.production
```

Back on the VPS:

```sh
cd ~/vn-reader
chmod 600 .env.production data/vps-migration.tar.gz
```

The private `.env.production` stays on the VPS and is excluded from Git and Docker build contexts. Do not paste it into chat, use `docker compose config` without `--quiet`, or share `docker inspect` output: those can expose environment secrets.

## 4. Set production authentication and SMTP

See [EMAIL.md](EMAIL.md) for email-provider selection, Amazon SES setup, DNS records, and the two-device sync check.

Edit the transferred environment file:

```sh
nano .env.production
```

Set these values (preserve your working Telegram API ID/hash/token, channel, destination and archive topic):

```dotenv
VN_DOMAIN=vidurneeti.xyz
VN_ENV=production
BETTER_AUTH_URL=https://vidurneeti.xyz
VN_ALLOWED_ORIGINS=https://vidurneeti.xyz
BETTER_AUTH_SECRET=YOUR_PERSISTENT_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
VN_SMTP_HOST=YOUR_SMTP_HOST
VN_SMTP_PORT=587
VN_SMTP_USERNAME=YOUR_SMTP_USERNAME
VN_SMTP_PASSWORD=YOUR_SMTP_PASSWORD
VN_SMTP_FROM=VN Reader <noreply@vidurneeti.xyz>
VN_SMTP_SSL=false
```

Choose an SMTP provider and use its SMTP credentials. In the environment file, wrap values containing `$` or `#` in single quotes so Compose preserves them literally. Verify the sender/domain and add the provider's SPF/DKIM DNS records in Cloudflare. Port 587 uses STARTTLS with `VN_SMTP_SSL=false`; port 465 uses `VN_SMTP_SSL=true`. Check Oracle egress restrictions if email delivery fails. Better Auth handles email/password and verification OTPs; an email provider still delivers the messages. Without SMTP, guest reading works and account login stays disabled.

For a **new installation without existing accounts**, this generates a secret directly into the private file without printing it or putting it into shell history:

```sh
python3 - <<'PY'
from pathlib import Path
import secrets
path = Path('.env.production')
lines = [line for line in path.read_text().splitlines() if not line.startswith('BETTER_AUTH_SECRET=')]
lines.append('BETTER_AUTH_SECRET=' + secrets.token_hex(32))
path.write_text('\n'.join(lines) + '\n')
path.chmod(0o600)
PY
```

If migrating existing accounts, preserve the **existing** Better Auth secret. Do not regenerate it during upgrades.

## 5. Save the Cloudflare token privately

On the VPS, enter Bash and use the hidden prompt. Paste only the tunnel token and press Enter. It will not appear in your terminal or shell history.

```sh
bash
umask 077
read -r -s -p 'Cloudflare tunnel token: ' VN_TUNNEL_TOKEN
printf '\n'
printf '%s' "$VN_TUNNEL_TOKEN" > deploy/secrets/cloudflare-tunnel-token
unset VN_TUNNEL_TOKEN
sudo chown root:root deploy/secrets/cloudflare-tunnel-token
sudo chmod 0400 deploy/secrets/cloudflare-tunnel-token
```

The tunnel container reads this file as a read-only Compose secret. Its process arguments contain the file path, not the token. The file must belong to root because the container runs as root with all Linux capabilities dropped. An Ubuntu-owned file with mode 600 will cause `permission denied`. Root ownership with mode 0400 keeps the token private without expanding container capabilities. The container has no published host ports.

## 6. Build and restore the completed archive

Docker Compose is already installed on your VPS. Verify it and enable Docker at boot:

```sh
docker compose version
sudo systemctl enable --now docker
```

If your user cannot access Docker, use `sudo docker` in the commands or add the user to the Docker group and reconnect. Define this convenience function **in each new shell**:

```sh
cd ~/vn-reader
dc() { docker compose --env-file .env.production -f compose.yaml -f deploy/compose.tunnel.yaml "$@"; }
dc config --quiet
dc build
```

Container builds and Compose validation have not been run on the development Mac because Docker is unavailable there. Run the commands above on the VPS before launch. Builds use multi-architecture upstream Node/Python/Caddy images; Oracle A1 builds its native ARM64 images. Restore once, **before starting services**:

```sh
docker volume create vn-reader_account-data
dc run --rm --no-deps --user 0 --entrypoint python --volume "$PWD/data/vps-migration.tar.gz:/migration.tar.gz:ro" --volume "$PWD/deploy/restore-migration.py:/restore-migration.py:ro" --volume vn-reader_account-data:/accounts archive /restore-migration.py
```

The archive service automatically mounts `vn-reader_telegram-data:/data`. The restore helper copies only known database/session files, sets container ownership to UID 1000 and refuses to overwrite existing files. Run it only once against fresh volumes. Do not use `down -v`: that deletes persistent data.

## 7. Start everything

```sh
dc up -d
dc ps
dc logs --tail 50 accounts archive web tunnel
dc logs -f --tail 30 mirror
```

The account/archive services have health checks. The web service starts after they are healthy. The mirror subscribes to channel messages/edits, allows approximately two seconds for albums to settle and runs a fallback catch-up check every 15 seconds. Reconnection/checkpoints recover missed messages. This is a continuously running container, not a cron job. Telegram/network limits can delay updates.

The mirror should report **Caught up · listening for new posts**. `Ctrl+C` exits the log viewer; it does not stop the detached containers. You can close SSH and your local terminal. Docker restarts services after a VPS reboot. Keep the Mac mirror stopped once the VPS mirror is active.

## 8. Verify the deployed site

```sh
curl -fsS https://vidurneeti.xyz/api/health
curl -fsS https://vidurneeti.xyz/api/config
curl -fsS https://vidurneeti.xyz/api/archive-health
```

Confirm `accountsEnabled` is true after SMTP configuration and the tunnel shows Healthy in Cloudflare. Then check:

- Website opens over HTTPS and loads the existing archive without copying it again.
- Images/videos load, video seeking works, and timeline previews navigate directly to the chosen post.
- Email signup delivers the OTP; verification, password login and password reset work.
- A logged-in user's reading state appears on a second device. Guest reading still works.
- The next genuine source-channel post appears in the private archive topic and website. Do not post test messages to the public channel.

If the tunnel reports **502**, inspect archive/accounts health and the `web:80` route. A route to `localhost:80` would point inside the tunnel container and is incorrect. For Telegram unauthorized-session errors, stop the VPS services and check that the authorized reader session was migrated. Never start a duplicate mirror to debug it.

## 9. Back up and update

Both volumes are essential. For a consistent full-volume backup, briefly stop the application writers, archive both volumes, then restart:

```sh
mkdir -p data/backups
dc stop tunnel web mirror archive accounts
dc run --rm --no-deps --user 0 --entrypoint python --volume "$PWD/data/backups:/backup" --volume vn-reader_account-data:/accounts archive -c 'import datetime,os,tarfile; p="/backup/vn-reader-"+datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")+".tar.gz"; t=tarfile.open(p,"w:gz"); t.add("/data",arcname="telegram"); t.add("/accounts",arcname="accounts"); t.close(); os.chmod(p,0o600); print(p)'
dc up -d
```

The backup is written by container root; use `sudo` to copy it securely off the VPS if your SSH user cannot read it. Also keep an encrypted off-VPS copy of `.env.production` and the tunnel token. Volume backup archives contain private sessions/accounts; do not store them in a public Telegram topic or web directory. The migration helper is for first migration; full-volume backups must be restored into stopped volumes, preserving the `telegram/` → `/data` and `accounts/` → `/accounts` directory mapping.

For an update, back up first, pull the updated source with `git pull --ff-only`, then:

```sh
dc build
dc pull tunnel
dc up -d --remove-orphans
dc ps
```

Do not change secrets or delete volumes. Update cloudflared through Compose rather than running a second system service. The image currently tracks `latest`; after your first validated deployment you can pin its tested image digest for reproducible upgrades.

## Capacity

4–5k daily visitors is a reasonable launch target to measure, not a concurrency guarantee. Static files are small; video traffic dominates. Track simultaneous streams, bandwidth, response times, memory, Telegram FloodWaits and disk usage on the A1 instance. A tunnel does not remove the VPS's streaming bandwidth or Telegram limits. Avoid custom caching of media/auth until the delivery rules and provider plan are checked. Scale based on actual concurrent viewing, not daily visitor count alone.
