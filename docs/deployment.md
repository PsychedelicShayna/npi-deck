# Deployment

npi-deck ships **without an authentication layer**. It is designed to be
loopback-only with network access gated by something else — Tailscale, an SSH
tunnel, or a reverse proxy with its own auth. Do not bind it to a public
interface without one of these.

## Patterns

- [Tailscale-gated (recommended)](#tailscale-gated-recommended)
- [SSH tunnel](#ssh-tunnel)
- [Hardening checklist](#hardening-checklist)

## Tailscale-gated (recommended)

Bind the deck to loopback. Tailscale Serve exposes it to your tailnet over
HTTPS with mTLS-style identity.

```sh
# Run the deck loopback-only — the default
NPI_DECK_HOST=127.0.0.1 NPI_DECK_PORT=8787 bun run start

# Then on the same host:
tailscale serve --bg --https=443 http://127.0.0.1:8787

# Open from any tailnet device — including your phone:
open https://<hostname>.<tailnet>.ts.net
```

Tailscale handles the TLS termination + identity check. Only devices on your
tailnet can reach the deck.

**Sharing externally** — use Tailscale Funnel:

```sh
tailscale funnel --bg --https=443 http://127.0.0.1:8787
```

Funnel exposes the URL to the public internet. Anyone with the link can
reach the deck. Combine with bearer-token auth at the reverse proxy layer if
you want this to be safe to share.

## SSH tunnel

If you don't run Tailscale on the host:

```sh
# On the deck host:
bun run start                                        # bound to 127.0.0.1:8787

# On your local box:
ssh -L 8787:127.0.0.1:8787 user@deck-host
# Then open http://localhost:8787 in your laptop browser
```

Stick it in `~/.ssh/config` for a persistent tunnel:

```
Host deck-host
  HostName <ip-or-hostname>
  User <user>
  LocalForward 8787 127.0.0.1:8787
```

## Production knobs worth setting

```sh
NPI_DECK_DB_PATH=/var/lib/npi-deck/deck.db    # outside the checkout
NPI_DECK_DATA_DIR=/var/lib/npi-deck           # managed .env + audit + bridge db
PI_CODING_AGENT_DIR=/var/lib/omp/agent        # NeoPi agent dir: sessions + auth
NPI_DECK_DEFAULT_CWD=/workspace               # mount your code here
LOG_LEVEL=warn                                # quieter in steady state
```

## Hardening checklist

Before exposing the deck on a network anyone else can reach:

- [ ] `NPI_DECK_HOST=127.0.0.1` (default). Confirm with `ss -tlnp` or `netstat`.
- [ ] Front it with Tailscale Serve, an SSH tunnel, or a reverse proxy that
      enforces auth. Never bind `0.0.0.0` without one.
- [ ] Provider API keys live in env vars (via shell profile or the deck's
      managed `.env`) — never committed in the repo or shipped in an image.
- [ ] The data dir (`NPI_DECK_DATA_DIR`) is user-only readable. `chmod 700` on
      Unix; Windows `%LOCALAPPDATA%` is per-user by default.
- [ ] The audit log (`env-audit.log`) is rotated or archived if the deck runs
      for a long time. Today it grows unbounded.
- [ ] If Telegram bridge is in use, `TELEGRAM_ALLOWED_USERS` is set. The
      bridge refuses to start without it.
- [ ] If exposing via Funnel, you accept that anyone with the URL can drive
      the chat. Add a reverse-proxy auth layer for any shared deployment.

## Updating

The deck embeds the omp SDK as a workspace dep. To pull a newer SDK:

```sh
bun update @oh-my-pi/pi-coding-agent
bun run typecheck
bun run build
```

Then restart the deck (Settings → Env → Restart, or kill+respawn).
