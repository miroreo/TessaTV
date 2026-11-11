# Deploying TessaTV

TessaTV ships as one container image: the Fastify server, the SvelteKit UI it serves at
`/`, ffmpeg/ffprobe, and the VAAPI drivers (Mesa for AMD, `intel-media-va-driver` for
Intel). It needs a Postgres database; migrations run at startup, so a new version needs no
manual step.

## The image

Built from the repo root by `docker/Dockerfile`:

```bash
docker build -f docker/Dockerfile -t tessatv .          # or: podman build ...
```

CI (`.github/workflows/publish-image.yml`) also publishes it to GitHub Container Registry:
`ghcr.io/miroreo/tessatv:latest` on every push to `master`, `:sha-<short>` for each commit,
and `:1.2.3` / `:1.2` for `v*` tags. Pull requests only build it. It is `linux/amd64` only.
The package is private until you make it public (GitHub → Packages → Package settings);
pulling a private one needs `docker login ghcr.io` with a token that has `read:packages`.

What it does, so the run options below make sense:

- Serves on **8096** (`PORT`), Jellyfin's port, on all interfaces.
- Runs as the unprivileged `node` user (uid 1000) by default. Any uid works (`--user`): the
  app only writes to `TRANSCODE_DIR` and `/tmp`.
- `TRANSCODE_DIR` is `/transcodes`; mount a volume or tmpfs there.
- `tini` is PID 1, so ffmpeg children are reaped and `SIGTERM` stops the server cleanly.
- A `HEALTHCHECK` polls `GET /health`.

Environment (validated at startup by `packages/config`; a bad value stops the server):

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/db`, or a Unix socket: `postgresql://user@%2Frun%2Fpostgresql/db` |
| `APP_SECRET` | yes | 32+ chars (`openssl rand -base64 32`). Derives the credential encryption key and the Jellyfin server id, so keep it stable. |
| `TMDB_API_KEY`, `TVDB_API_KEY` | no | Metadata for movies / shows is disabled until set. |
| `HARDWARE_ACCEL` | no | `auto` (default: VAAPI if it works, else software), `none`, `vaapi` (fails startup if VAAPI doesn't work). |
| `VAAPI_DEVICE` | no | Defaults to `/dev/dri/renderD128`. |
| `VAAPI_HARDWARE_DECODE` | no | `false` (default): the CPU decodes and the GPU only encodes, because corrupt input can hang a GPU decoder and freeze the machine. `true` decodes on the GPU too (faster for 4K). |
| `MAX_CONCURRENT_TRANSCODES` | no | Default 3. |

Media is mounted **read-only at the same path as on the host**, so the folder paths you
enter on the Settings page are the same inside and outside the container.

For VAAPI, pass the render node (`--device /dev/dri/renderD128`) and add the device's group
**by number** (`--group-add $(stat -c %g /dev/dri/renderD128)`): the app isn't root, and
group names resolve inside the container, where `render` doesn't exist. The startup log
says `Transcoding with hardware accel: vaapi` when it worked.

## Docker Compose (app + its own Postgres)

```bash
cp .env.example .env    # set APP_SECRET, and optionally TMDB_API_KEY / TVDB_API_KEY
MEDIA_ROOT=/data/tessatv docker compose -f docker/docker-compose.yml up -d --build
```

The compose file overrides `DATABASE_URL` for the container network and keeps Postgres on
`127.0.0.1:5432`. Uncomment its `devices`/`group_add` block for VAAPI. Then open
`http://<host>:8096/`, create the first account on the setup page, and add library folders
under Settings.

## NixOS: `virtualisation.oci-containers` with the host's `services.postgresql`

This runs the image under the NixOS oci-containers module (podman, as root, the module's
default) and connects to the Postgres that NixOS already runs.

**Database auth: Unix socket + peer auth (recommended).** NixOS's default `pg_hba.conf`
already has `local all all peer`: Postgres checks the OS user of the connecting process and
lets it in as the role of the same name. Rootful podman doesn't remap uids, so if the
container runs as the uid of a host user named `tessatv` and the host's `/run/postgresql`
is mounted in, the app logs in as role `tessatv` with **no password to manage**, and
Postgres doesn't need to listen on TCP at all. (A TCP alternative is further down.)

### 1. Build the image on the host

There's no published image yet, so build it into **root's** podman storage (that's where
the systemd unit looks; a rootless `podman build` lands somewhere else):

```bash
git clone https://github.com/miroreo/TessaTV && cd TessaTV
sudo podman build -f docker/Dockerfile -t localhost/tessatv:latest .
```

To update later: `git pull`, the same build, then `sudo systemctl restart podman-tessatv`.

### 2. Secrets

Put the secrets in a root-only env file outside the Nix store (the store is
world-readable). With agenix or sops-nix, point `environmentFiles` at the decrypted path
instead.

```bash
sudo install -d -m 0700 /etc/tessatv
sudo install -m 0400 /dev/stdin /etc/tessatv/secrets.env <<EOF
APP_SECRET=$(openssl rand -base64 32)
TMDB_API_KEY=
TVDB_API_KEY=
EOF
```

An empty key leaves that metadata provider off. If you're moving an existing install,
reuse its `APP_SECRET`.

### 3. The NixOS module

Adjust the media path (here `/data/tessatv`), then add this to your configuration and
`nixos-rebuild switch`:

```nix
{ config, ... }:

let
  # Fixed so the container's uid always maps to the `tessatv` user (and role) on the host.
  # Any free uid/gid works; change both together.
  tessatvUid = 8096;
in
{
  users.groups.tessatv.gid = tessatvUid;
  users.users.tessatv = {
    isSystemUser = true;
    uid = tessatvUid;
    group = "tessatv";
  };

  # Your existing Postgres: add the database and its owner role. The default pg_hba
  # (`local all all peer`) already lets the `tessatv` OS user in as role `tessatv`.
  services.postgresql = {
    ensureDatabases = [ "tessatv" ];
    ensureUsers = [
      { name = "tessatv"; ensureDBOwnership = true; }
    ];
  };

  # Transcode scratch space, owned by the container's user.
  systemd.tmpfiles.rules = [ "d /var/cache/tessatv 0750 tessatv tessatv -" ];

  virtualisation.podman.enable = true;
  virtualisation.oci-containers.backend = "podman";
  virtualisation.oci-containers.containers.tessatv = {
    image = "localhost/tessatv:latest";
    pull = "never"; # built locally (step 1); never try a registry
    user = "${toString tessatvUid}:${toString tessatvUid}";
    ports = [ "8096:8096" ];
    environment = {
      DATABASE_URL = "postgresql://tessatv@%2Frun%2Fpostgresql/tessatv";
      HARDWARE_ACCEL = "auto";
    };
    environmentFiles = [ "/etc/tessatv/secrets.env" ];
    volumes = [
      "/run/postgresql:/run/postgresql" # the socket directory, not the socket file
      "/data/tessatv:/data/tessatv:ro" # same path inside, read-only
      "/var/cache/tessatv:/transcodes"
    ];
    extraOptions = [
      # VAAPI: the render node, plus its group by number (the app isn't root).
      # Check the gid with `stat -c %g /dev/dri/renderD128`; NixOS's `render` group is 303.
      "--device=/dev/dri/renderD128"
      "--group-add=${toString config.users.groups.render.gid}"
    ];
  };

  # Start after Postgres and after NixOS has created the role and database.
  systemd.services.podman-tessatv = {
    requires = [ "postgresql.service" ];
    after = [ "postgresql.service" "postgresql-setup.service" ];
  };

  networking.firewall.allowedTCPPorts = [ 8096 ];
}
```

Notes:

- The socket's directory is mounted rather than the socket file, so the mount survives
  Postgres restarts (which recreate the socket).
- On a NixOS release without `postgresql-setup.service` (older than 25.05, where
  `postgresql.service` itself creates the roles), the extra `after` entry is harmless.
- `pull = "never"` needs a recent nixpkgs; on an older one, drop the line (an image that's
  already present isn't pulled).
- Behind a reverse proxy instead of the firewall port, use `ports = [ "127.0.0.1:8096:8096" ];`.
  Jellyfin Mobile on the LAN needs the port reachable, so keep it open if you use it.

### 4. Check it

```bash
systemctl status podman-tessatv
journalctl -u podman-tessatv -f        # expect "listening on port 8096" and the accel line
curl http://localhost:8096/health      # {"status":"ok"}
```

Then open `http://<host>:8096/`, create the first account, and add `/data/tessatv/movies`
and `/data/tessatv/shows` (or wherever your media is) under Settings.

If startup fails with `role "tessatv" does not exist` or
`Peer authentication failed for user "tessatv"`, check that `postgresql-setup` ran
(`systemctl status postgresql-setup`) and that the container really runs as the
`tessatv` uid (`sudo podman exec tessatv id`).

### Alternative: TCP with a password

If you'd rather not mount the socket (or podman runs rootless, which remaps uids and breaks
peer auth), use TCP on loopback with host networking:

```nix
services.postgresql.authentication = ''
  host tessatv tessatv 127.0.0.1/32 scram-sha-256
'';
```

Set the role's password once with `sudo -u postgres psql -c '\password tessatv'`, and in
the container definition: drop the `/run/postgresql` volume, `ports`, and `user` (the
default `node` uid works; then the transcode directory must be writable by uid 1000, or
use `--tmpfs=/transcodes`), add `"--network=host"` to `extraOptions`, and put
`DATABASE_URL=postgres://tessatv:<password>@127.0.0.1:5432/tessatv` in the secrets file
rather than in `environment`. Postgres's default `listen_addresses` is `localhost`, so this
needs no `enableTCPIP`.
