# Runbook — Southern IoT Files v2 on the VM

For the owner, on `rndserver`, in a **root** shell. Copy each block as it is. Every block says what you should see.

```
Cloudflare → proxy 10.10.8.100 → VM :5000 → sif-web (nginx) → sif-api (internal only)
```

| Path on the VM | What it is |
|---|---|
| `/opt/southern-iot/file-sharing/app` | the code (a git checkout; don't edit files here) |
| `/opt/southern-iot/file-sharing/.env` | settings and the shared password (root only, mode 600) |
| `/opt/southern-iot/file-sharing/data` | the database and every stored file |
| `/opt/southern-iot/file-sharing/backups` | nightly backups |

Everything is done with one script: `/opt/southern-iot/file-sharing/app/deploy/sif.sh` (`up`, `down`, `status`, `logs`, `update`, `backup`, `restore`).

## 1. First install

**1.1 Check the VM** (changes nothing):
```bash
docker compose version          # needs v2.21 or newer (for --wait-timeout)
git --version
df -h /                         # needs a few GB free
ss -ltnp | grep ':5000 ' || echo "port 5000 is free"
```
You should see: a compose version, a git version, and `port 5000 is free`.

**1.2 Get the code:**
```bash
mkdir -p /opt/southern-iot/file-sharing
cd /opt/southern-iot/file-sharing
git clone --branch v2.0.0 https://github.com/Ayman-ilias/file_sharing.git app
```
(The `detached HEAD` note is normal: you are on the release tag.)

**1.3 Create the settings file and set the shared password:**
```bash
install -m 600 app/deploy/.env.example .env
nano .env
```
In `nano`, fill in `SHARED_PASSWORD=` (at least 10 characters, **no `$` sign**). Leave the rest. Save with Ctrl+O, Enter, then Ctrl+X.

**1.4 Start it** (the first build takes a few minutes):
```bash
app/deploy/sif.sh up
```
You should see `UP on port 5000` at the end.

**1.5 Check it:**
```bash
app/deploy/sif.sh status
```
You should see both `sif-api` and `sif-web` as `healthy`, and `health: {"ok":true}`.

Then open **https://files.southerneleven.com** in a browser. You should see the sign-in page.

**1.6 Check that the proxy is let in:**
```bash
app/deploy/sif.sh logs web
```
(Ctrl+C to stop.) You should see the requests from step 1.5 starting with `10.10.8.100`.
- If they start with **another IP** and show `403`, that IP is how the proxy reaches the container. Put it in `.env` next to the old one, e.g. `TRUSTED_PROXIES=10.10.8.100 172.17.0.1`, then run `app/deploy/sif.sh up`.
- If you see **nothing at all**, the proxy at 10.10.8.100 isn't reaching port 5000. Check its "file sharing" host still points to this VM's IP, port 5000.

**1.7 Nightly backup** (02:15 every night):
```bash
crontab -l 2>/dev/null | { cat; echo '15 2 * * * /opt/southern-iot/file-sharing/app/deploy/sif.sh backup >> /opt/southern-iot/file-sharing/backups/backup.log 2>&1'; } | crontab -
app/deploy/sif.sh backup
```
You should see `backup: /opt/southern-iot/file-sharing/backups/sif-<date>.tar.gz (…)`.

A backup holds the database and everyone's **My storage** (encrypted). Shared files are **not** backed up: they expire after 30 days anyway. The script keeps the newest 14 backups, using at most 5 GB.

These backups sit on the same disk as the data. To keep a copy somewhere else, copy the newest one off the VM now and then, for example from your own computer:
`scp root@<VM-IP>:/opt/southern-iot/file-sharing/backups/sif-*.tar.gz .`

## 2. Settings on the other boxes (check once)

- **Proxy at 10.10.8.100** (probably Nginx Proxy Manager), on the file-sharing host:
  - It must accept uploads of at least **20 MB per request**. In NPM's Advanced tab: `client_max_body_size 20m;`. Files are sent in 16 MB pieces, so big files still work.
  - It must allow requests longer than **60 s**: `proxy_read_timeout 1h;` (live updates keep a connection open).
  - It should only take traffic coming from Cloudflare. Otherwise someone on the office network could fake their address to the login limit.
- **Cloudflare**, for southerneleven.com: turn **Rocket Loader** and **Email Address Obfuscation** off. Both inject scripts that the site's security policy blocks.

## 3. After a week

The login limit is relaxed for launch day, because the whole office registers from one address. Put it back:
```bash
cd /opt/southern-iot/file-sharing
sed -i 's/^LOGIN_RATE_LIMIT=.*/LOGIN_RATE_LIMIT=10/' .env
app/deploy/sif.sh up
```

## 4. Everyday commands

```bash
cd /opt/southern-iot/file-sharing
app/deploy/sif.sh status          # is it up?
app/deploy/sif.sh logs            # live logs of both (Ctrl+C to stop); "logs api" or "logs web" for one
app/deploy/sif.sh down            # stop it (data stays)
app/deploy/sif.sh up              # start it again / apply a changed .env
```

## 5. Updating to a new version

```bash
cd /opt/southern-iot/file-sharing
app/deploy/sif.sh backup
app/deploy/sif.sh update v2.0.1   # the new release tag
```
You should see `code: <old> -> <new> (v2.0.1)` and `UP on port 5000`. Database changes run by themselves at start. To go back, run `app/deploy/sif.sh update v2.0.0`. If the new version changed the database, restore the backup you took first (section 6).

## 6. Restoring a backup

```bash
cd /opt/southern-iot/file-sharing
ls -lt backups/                                   # pick one
app/deploy/sif.sh restore backups/sif-2026-11-10-021500.tar.gz
```
This stops the site, moves the current database and My storage to `backups/before-restore-<date>/` (nothing is deleted), restores the backup, and starts again. Anything sent after that backup is gone from the lists.

## 7. If something is wrong

| You see | Do this |
|---|---|
| `sif.sh up` says `did not start` | It prints the api log first. The web part waits for a healthy api, so read the api log. |
| `.env can be read by others` | `chmod 600 /opt/southern-iot/file-sharing/.env` |
| `SHARED_PASSWORD is empty` | Fill it in `.env` (step 1.3). |
| `TRUSTED_PROXIES: not an IP or CIDR: …` in `logs web` | Fix that entry in `.env`, then `sif.sh up`. |
| The site shows `403 Forbidden` | See step 1.6. |
| Upload fails at "Sending…" for big files | Check the proxy's body size limit (section 2). |
| The disk is filling up | `df -h /`, then `du -sh /opt/southern-iot/file-sharing/*`. Shared files expire by themselves after 30 days. |

## Never run these

- `docker compose down -v`, `docker volume prune`, or `docker system prune --volumes` (not needed; the data isn't in a volume, but don't get into the habit)
- `rm -r /opt/southern-iot/file-sharing/data`: that is every user's files and the database
- `git clean -fdx` or editing files inside `app/`: `sif.sh update` refuses to run on a changed checkout

## After go-live (Claude prepares, the owner runs)

- **Speed benchmark** (spec §8): 50 MB, 500 MB and 2 GB through files.southerneleven.com, from the office and from outside. Results go to `docs/benchmarks.md`.
- **Security re-test:** the 2026-11-01 attack set against v2.
- **Live updates through the real path:** send a text from one browser and see it appear in another without reloading.
