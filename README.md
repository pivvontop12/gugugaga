# NovaMacro Portal

The portal serves the NovaMacro Premium Windows build after an administrator verifies payment and a customer redeems their account-specific portal key. The interface is in English.

## Start on Windows

Requires Node.js 24. From this folder, run `node --env-file-if-exists=.env server.mjs --setup` once and then `node --env-file-if-exists=.env server.mjs`. Open [NovaMacro Portal](http://127.0.0.1:8787/).

Setup generates a random administrator password. The setup command prints the path to the credentials file. On the original Windows machine this is `%LOCALAPPDATA%\NovaMacro Portal\admin-credentials.txt`. Read it locally and keep it private. Public registration creates customer accounts.

The Windows data directory also contains the SQLite database, server signing key, and private Premium ZIP. The server only serves the ZIP through its authenticated download route. The ZIP from the current setup is stored in the `downloads` subfolder.

## Personal PIN and account recovery

1. Email registration collects the name, email, and password. After **Continue**, the customer confirms a personal PIN of 6 to 8 digits.
2. Sign-in requires an email address, password and PIN. Existing accounts without a PIN and the initial administrator choose one during sign-in.
3. To help a customer recover access, open **Customers → Manage → Account access**. Match the customer to their account and verify their identity in their private support ticket. Select **Generate recovery code** and share the code in that ticket.
4. The customer opens **Forgot password or PIN?**, enters the code, and sets a new password and PIN. Customers who previously signed in through Discord also enter an email address. This links their existing license to the same account for email sign-in.

Recovery codes expire after 15 minutes and work once. Issuing a new code replaces the previous one. Completing recovery revokes the customer's existing web sessions. The database stores salted password and PIN hashes, and the admin panel shows the account identifiers and PIN setup status.

## Payment and activation

1. The customer registers in the portal and opens a purchase ticket.
2. In the admin portal, find the registration under Customers and select Manage.
3. Confirm that payment was verified. Select Lifetime or set a duration in days, then generate the key. Copy the NMP key while it is visible and send it to the specific purchaser in their private ticket.
4. The customer enters their NMP key under Overview. Their account now has access to the Premium ZIP. A timed license starts at this redemption.
5. They extract and launch Premium, copy the NM2-format Device Code shown in that window, and paste it into Devices on the portal. The portal returns the NM3-format desktop activation key, which they paste into NovaMacro Premium.

A portal license links to one Windows PC. The admin can update the duration, revoke the key, or reset the linked PC. The activity log records these operations. Private download access is checked for every download request. The new desktop build checks the signed device lease periodically while open and can use a valid lease offline for up to 24 hours. The desktop locks after a server rejection or expiry of the cached lease. Existing offline NM2 keys use their original rules.

## Caricare il progetto su GitHub

1. Crea un [repository privato su GitHub](https://github.com/new) chiamato `novamacro-portal`.
2. Apri la cartella **NovaMacro-Portal-GitHub** e trascina il suo contenuto in **Add file → Upload files**. Se il repository è vuoto, usa **uploading an existing file** nella schermata iniziale.
3. Controlla che `server.mjs`, `store.mjs`, `package.json` e le cartelle `public` e `test` siano al primo livello del repository. Includi anche `.gitignore` e `.env.example`. Conferma il caricamento. [Guida al caricamento su GitHub](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)

Puoi anche usare Git. Crea il repository vuoto e lancia questi comandi dalla cartella **NovaMacro-Portal-GitHub**, usando il tuo nome utente:

```powershell
git init -b main
git add .
git diff --cached --name-only
git commit -m "Prepare NovaMacro Premium portal"
git remote add origin https://github.com/YOUR-USERNAME/novamacro-portal.git
git push -u origin main
```

Il repository contiene solo il sorgente e il modello `.env.example`. Tieni il file `.env` effettivo, il database SQLite, la chiave di firma, le credenziali admin e lo ZIP Premium sul server o nei backup privati. [Guida Git all’importazione](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)

GitHub custodisce il codice. Per rendere operativo il portale, segui la configurazione della VM qui sotto. [Documentazione GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)

## Deploy on an Oracle Cloud Linux VM

1. Create an [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) Ubuntu VM with a public IPv4 address. For HTTPS, allow inbound TCP ports 80 and 443 in the VM's subnet security list and any operating system firewall. Keep SSH available to your own IP. [Oracle network guide](https://docs.oracle.com/en/learn/lab_compute_instance/)
2. Once Aruba activates the domain, set the [A record for `novamacro.eu`](https://guide.aruba.it/hosting-e-domini/gestione-dns/gestione-name-server-e-record/gestire-record-a) to the VM's public IPv4 address.
3. On the VM, install [Node.js 24](https://nodejs.org/en/download), [Caddy](https://caddyserver.com/docs/install#debian-ubuntu-raspbian), and Git. Give the VM a [read-only deploy key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys) for the private GitHub repository, then clone the repository as `ubuntu`.

```bash
git clone git@github.com:YOUR-USERNAME/novamacro-portal.git /home/ubuntu/novamacro-portal
cd /home/ubuntu/novamacro-portal
install -d -m 700 /home/ubuntu/.local/share/novamacro/downloads
cp .env.example .env
chmod 600 .env
```

Use these settings in `.env`, and replace the example admin email before setup.

```dotenv
PORT=8787
HOST=127.0.0.1
PUBLIC_ORIGIN=https://novamacro.eu
TRUST_LOCAL_PROXY=1
NM_DATA_DIR=/home/ubuntu/.local/share/novamacro
PREMIUM_ZIP=/home/ubuntu/.local/share/novamacro/downloads/NovaMacro-Premium.zip
ADMIN_EMAIL=owner@example.com
```

To use the current Premium archive, transfer `portal-signing.pem`, `downloads/NovaMacro-Premium.zip` and its optional `.sha256` companion from your Windows portal data directory into the matching locations under `NM_DATA_DIR` over SSH/SFTP. Set the signing key permissions to `600`. Copy the signing key before setup so the server can issue leases the current Premium build can verify. For a different build, compare its embedded portal public key with the output of `node --env-file-if-exists=.env server.mjs --public-key`. If moving live accounts and licenses, transfer a consistent SQLite backup as well.

```bash
node --env-file-if-exists=.env server.mjs --setup
node --test test/portal.test.mjs
```

Save this as `/etc/systemd/system/novamacro.service`. Use the absolute Node.js path returned by `command -v node` for `ExecStart`.

```ini
[Unit]
Description=NovaMacro Premium Portal
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/novamacro-portal
ExecStart=/usr/local/bin/node --env-file=.env server.mjs
Restart=on-failure
UMask=0077

[Install]
WantedBy=multi-user.target
```

For a dedicated VM, put this domain block in `/etc/caddy/Caddyfile`. Caddy obtains and renews HTTPS certificates automatically when the DNS record and ports are ready. [Automatic HTTPS](https://caddyserver.com/docs/automatic-https)

```caddyfile
novamacro.eu {
    reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now novamacro
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
curl -fsS https://novamacro.eu/api/state
```

Open the portal, sign in with the administrator credentials generated by setup, and choose your PIN. Check that an unpaid customer receives a locked download, then verify key redemption, download and desktop activation with a paid test account before announcing the domain.

Keep protected backups of the SQLite database and the server signing key. Issue public activation keys from the production URL so customers' desktops can renew them.

## Checks

`node --test test/portal.test.mjs` verifies PIN enrollment, account recovery, email migration for legacy accounts, the payment gate, private download, and device activation and renewal. It uses a temporary database and test archive.
