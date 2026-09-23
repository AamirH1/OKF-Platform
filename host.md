# Hosting OKF Platform for free

This guide puts the complete platform online at **$0/month** using:

| Piece | Service | Why |
|---|---|---|
| Server | **Oracle Cloud Always Free** ARM VM (up to 4 CPUs / 24 GB RAM) | Big enough to run every part of the app, including malware scanning |
| HTTPS & public address | **Cloudflare Tunnel** (free) | Secure HTTPS without opening any ports on the server |
| Email (password resets, invitations) | **Brevo** or **Resend** free SMTP | Sends the app's emails |

Everything runs with the production Docker Compose file already in this repo
([`docker-compose.prod.yml`](docker-compose.prod.yml)).

> **Time needed:** 30–45 minutes the first time.
> **Free-tier terms change** — check each provider's current limits before relying on them.

---

## What you need before starting

- [ ] An **Oracle Cloud** account — <https://cloud.oracle.com> (a card is requested for identity checks; Always Free resources are not charged)
- [ ] A **Cloudflare** account — <https://dash.cloudflare.com>
- [ ] A **domain name** added to Cloudflare (any registrar; ~$10/year). This guide uses `yourdomain.com` — replace it everywhere.
- [ ] An **SMTP login** from Brevo (<https://www.brevo.com>) or Resend (<https://resend.com>) — optional, but without it password-reset and invitation emails will not be sent
- [ ] An **SSH key** on your computer (`ls ~/.ssh/id_ed25519.pub`; create one with `ssh-keygen -t ed25519` if missing)

The app will use two addresses:

| Address | Serves |
|---|---|
| `https://app.yourdomain.com` | The website (and its API) |
| `https://files.yourdomain.com` | File storage — browsers upload bundles here directly |

---

## Step 1 — Create the server (Oracle Cloud)

1. Sign in to Oracle Cloud and pick your **home region** (Always Free resources must be in it).
2. Open **☰ → Compute → Instances → Create instance**.
3. Set:
   - **Name:** `okf-platform`
   - **Image:** Canonical **Ubuntu 24.04**
   - **Shape:** *Change shape* → **Ampere** → `VM.Standard.A1.Flex` → **4 OCPUs, 24 GB memory**
     (smaller works too: 2 OCPUs / 12 GB is enough without ClamAV)
   - **SSH keys:** *Paste public key* → paste the contents of `~/.ssh/id_ed25519.pub`
   - **Boot volume:** 100 GB (Always Free includes up to 200 GB total)
4. Click **Create** and wait until the state is **Running**.
5. Copy the **Public IP address** and connect from your computer:

   ```bash
   ssh ubuntu@<PUBLIC_IP>
   ```

> "Out of capacity" error? Ampere capacity is limited in some regions — retry later, or try another
> availability domain in the create form.

---

## Step 2 — Install Docker and download the app

On the server:

```bash
# Docker + Compose plugin
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
newgrp docker

# Check
docker version && docker compose version

# The app
git clone https://github.com/AamirH1/OKF-Platform.git
cd OKF-Platform
```

---

## Step 3 — Create the Cloudflare Tunnel

The tunnel is an outbound connection from your server to Cloudflare, so the server never needs to
accept incoming web traffic.

1. In the Cloudflare dashboard open **Zero Trust → Networks → Tunnels → Create a tunnel**.
2. Choose **Cloudflared**, name it `okf`, and click **Save tunnel**.
3. On the install screen, find the command containing `--token eyJ...` and **copy only the token**
   (the long string after `--token`). Keep it secret. You do not need to run the install command.
4. Click **Next** and add two **Public Hostnames**:

   | Subdomain | Domain | Service type | URL |
   |---|---|---|---|
   | `app` | `yourdomain.com` | HTTP | `web:3000` |
   | `files` | `yourdomain.com` | HTTP | `minio:9000` |

5. Save. Cloudflare creates the DNS records and HTTPS certificates automatically.

---

## Step 4 — Configure secrets

Generate three strong random passwords:

```bash
for i in 1 2 3; do openssl rand -hex 24; done
```

Create the configuration file:

```bash
nano .env.production
```

Paste the following, replace every `<…>` value, then save (`Ctrl+O`, `Enter`, `Ctrl+X`):

```bash
# Public addresses (from Step 3)
WEB_ORIGIN=https://app.yourdomain.com
S3_PUBLIC_ENDPOINT=https://files.yourdomain.com
TRUST_PROXY=true

# Secrets (from the openssl command)
POSTGRES_PASSWORD=<random-1>
REDIS_PASSWORD=<random-2>
S3_ACCESS_KEY_ID=okfadmin
S3_SECRET_ACCESS_KEY=<random-3>

# Email (Brevo example; Resend: smtp://resend:<API_KEY>@smtp.resend.com:587)
SMTP_URL=smtp://<smtp-login>:<smtp-key>@smtp-relay.brevo.com:587
MAIL_FROM=OKF Platform <no-reply@yourdomain.com>

# Security
MALWARE_SCANNER=clamav
# Keep uploads within ClamAV's scan size (see "Upload size" below)
UPLOAD_MAX_BYTES=26214400
METRICS_TOKEN=<optional-random-string>

# Cloudflare Tunnel token (from Step 3)
TUNNEL_TOKEN=<tunnel-token>
```

Lock the file down:

```bash
chmod 600 .env.production
```

> **Upload size:** uploads are virus-scanned before processing and anything the scanner can't
> check is rejected. `26214400` (25 MB) stays within ClamAV's default stream limit. To allow larger
> bundles, raise `StreamMaxLength` in ClamAV's `clamd.conf` and `UPLOAD_MAX_BYTES` together.

---

## Step 5 — Add the tunnel service

Create a small Compose file that runs the tunnel next to the app:

```bash
cat > docker-compose.tunnel.yml <<'EOF'
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}
    restart: unless-stopped
EOF
```

To avoid typing long commands, create a shortcut (add it to `~/.bashrc` to keep it):

```bash
alias okf='docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml --env-file .env.production'
echo "alias okf='docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml --env-file .env.production'" >> ~/.bashrc
```

---

## Step 6 — Start everything

```bash
okf up -d --build
```

The first run takes **5–10 minutes**: it builds the web, API and worker images, then starts
PostgreSQL, Redis, MinIO storage, ClamAV, runs database migrations, creates the storage bucket and
opens the tunnel.

Check status:

```bash
okf ps
```

Every service should be `running` / `healthy`. The one-off `migrate` and `minio-init` services show
`exited (0)` — that is correct. ClamAV may take ~5 minutes on first start while it downloads its
virus database.

---

## Step 7 — Use it

1. Open **https://app.yourdomain.com** — you should see the Home page.
2. **Sign up** → create an **organization** → **New dataset** → upload a bundle
   (try the samples in `tests/fixtures/okf/`, zipped).
3. Watch the progress bar; when it finishes, explore the dataset and **Publish** it.

Optional demo data (runs through the public API):

```bash
docker run --rm --network okf-platform-prod_default -v "$PWD:/app" -w /app \
  -e API_URL=http://api:4000 node:24-bookworm-slim sh -c "npm ci --omit=dev --ignore-scripts >/dev/null && node scripts/seed.mjs"
```

---

## Step 8 — Day-to-day operations

| Task | Command |
|---|---|
| Deploy the latest code | `git pull && okf up -d --build` |
| See status | `okf ps` |
| Follow API/worker logs | `okf logs -f --tail 100 api worker` |
| Restart one service | `okf restart api` |
| Stop everything | `okf down` (data is kept in Docker volumes) |
| Disk usage | `docker system df` |
| Free old build space | `docker image prune -f` |

### Backups (important)

Nightly database backup at 03:00, keeping 14 days:

```bash
mkdir -p ~/backups
crontab -e
```

Add:

```cron
0 3 * * * docker exec okf-platform-prod-postgres-1 pg_dump -U okf -Fc okf > ~/backups/okf-$(date +\%F).dump && find ~/backups -name 'okf-*.dump' -mtime +14 -delete
```

Uploaded files live in the `minio-data` Docker volume (bucket versioning is enabled). For
off-server safety, periodically copy `~/backups` and the MinIO data elsewhere (e.g. with
`rclone` to Cloudflare R2 or Backblaze B2 free tiers).

Restore a database backup:

```bash
cat ~/backups/okf-YYYY-MM-DD.dump | docker exec -i okf-platform-prod-postgres-1 pg_restore -U okf -d okf --clean --if-exists
```

---

## Security checklist

- [ ] Oracle **security list** allows only **SSH (22)** inbound — the default. Do **not** open 3000,
      4000, 5432 or 9000: all web traffic arrives through the tunnel.
- [ ] `.env.production` is `chmod 600` and never committed (it is git-ignored).
- [ ] SSH uses keys only (Oracle's Ubuntu image disables password login by default).
- [ ] Keep the OS patched: `sudo apt update && sudo apt upgrade -y` (enable
      `unattended-upgrades` for automatic security updates).
- [ ] Set `METRICS_TOKEN` if you expose `/metrics` to a monitoring tool.
- [ ] Optional: in Cloudflare **Zero Trust → Access**, protect `app.yourdomain.com` behind a login
      while you test.

See [docs/security.md](docs/security.md) for the application's security model.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Site shows **Cloudflare error 1033 / 502** | Tunnel not connected: `okf logs cloudflared`. Check `TUNNEL_TOKEN`, and that the hostnames point to `web:3000` and `minio:9000` (service names, not `localhost`). |
| Upload fails with a **storage / ETag / CORS** error | `S3_PUBLIC_ENDPOINT` must be exactly `https://files.yourdomain.com` and `WEB_ORIGIN` exactly `https://app.yourdomain.com` (no trailing slash). Rebuild after changing: `okf up -d --build`. |
| Version stuck at **Processing** | `okf logs -f worker`. If it says the scanner is unavailable, ClamAV is still starting (`okf logs clamav`). |
| Version fails with **SCANNER / too large** | The file exceeds ClamAV's scan limit — see "Upload size" in Step 4. |
| **Sign-in doesn't stick** / CSRF errors | `WEB_ORIGIN` must match the address in your browser exactly, and `TRUST_PROXY=true`. |
| Password-reset emails never arrive | `okf logs api \| grep -i mail`; verify `SMTP_URL` and that `MAIL_FROM` uses a sender verified with your SMTP provider. |
| `migrate` exited with an error | `okf logs migrate` — usually a wrong `POSTGRES_PASSWORD` after the database was first created. The password is fixed at first start; to reset a fresh install: `okf down -v` (**deletes all data**). |
| Build runs out of memory | Use a larger shape, or add swap: `sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`. |

Health endpoints (from the server):

```bash
docker exec okf-platform-prod-api-1 node -e "fetch('http://127.0.0.1:4000/ready').then(r=>r.text()).then(console.log)"
```

---

## When to move beyond free

The free VM is ideal for demos, portfolios and small teams. For real users, consider a paid VM
(~$5–6/month runs this same setup unchanged) or the managed Google Cloud layout in
[docs/deployment.md](docs/deployment.md) (Cloud Run, Cloud SQL, Memorystore, GCS).
