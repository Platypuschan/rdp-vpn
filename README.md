# RDP Workspace

A GNOME Shell extension (GNOME 46–50, written for Bazzite's GNOME image) that
runs a FreeRDP session fullscreen on its own workspace. The remote desktop then
behaves like one more workspace: reach it with the usual workspace gestures and
shortcuts, or jump to it and back with a dedicated shortcut.

## Install

```bash
git clone https://github.com/Platypuschan/rdp-vpn.git
cd rdp-vpn
flatpak install flathub com.freerdp.FreeRDP   # unless a FreeRDP 3 client is already on the PATH
./install.sh
# log out and back in
gnome-extensions enable rdp-workspace@platypuschan.github.io
gnome-extensions prefs rdp-workspace@platypuschan.github.io
```

Set host and user name in the preferences. The password can be saved there
(it goes to the GNOME keyring) or is asked for on connect.

### Running the client in a distrobox container with a VPN

If the RDP host is only reachable through a VPN, the container handles the VPN;
the extension only needs the container's name under "Distrobox container". It
then runs `distrobox enter --no-tty --name <container> -- <client>`.

`container/` contains a `Containerfile` for such a container: FreeRDP and
openconnect, with the VPN starting as a systemd service together with the
container and restarting if it drops. FreeRDP waits for the tunnel before
connecting. The image contains no credentials. GitHub Actions builds it on every
change and weekly, and publishes it as `ghcr.io/platypuschan/rdp-vpn`. The
container needs its own network (the VPN then affects only the container) and
systemd (`--init`):

```bash
distrobox create --name rdp-vpn --image ghcr.io/platypuschan/rdp-vpn:latest \
  --init --unshare-netns
distrobox enter rdp-vpn -- rdp-vpn-setup
```

To build the image yourself instead: `podman build -t localhost/rdp-vpn container`,
then use `localhost/rdp-vpn` as the image. Besides `latest`, every published
build is also tagged with its date (e.g. `:20261005`) for going back.

`rdp-vpn-setup` asks for server, user and password; run it again to change them.
To move to a newer image, pull it, recreate the container with the commands
above and run `rdp-vpn-setup` again:

```bash
podman pull ghcr.io/platypuschan/rdp-vpn:latest
distrobox stop rdp-vpn && distrobox rm rdp-vpn
```

The password is kept in `/etc/rdp-vpn/password` inside the container (readable
only by the container's root). Useful commands inside the container:

```bash
systemctl status rdp-vpn          # state
sudo journalctl -u rdp-vpn -f     # log
```

When a session started by the extension ends, the container shuts down, which
also ends the VPN. The next connect starts it again. To keep it running, set
`SHUTDOWN_AFTER_SESSION=no` in `/usr/local/libexec/wait-for-vpn`.

After 5 failed starts within 10 minutes the service stops retrying, so a wrong
password cannot lock the VPN account; `sudo systemctl reset-failed rdp-vpn`
and a restart start it again.

## Use

- Panel icon: connect / disconnect, jump to the RDP workspace, settings.
- `Super+Alt+R`: connect if there is no session; otherwise toggle between the
  RDP workspace and the one you came from.
- Closing the session (or logging off remotely) returns to the previous
  workspace; the now empty workspace is removed by GNOME as usual.
- Locking the screen keeps the session running.

## How it works

The extension starts the client with `/args-from:stdin` (so the password never
appears on a command line), recognises its window by the title it passed with
`/t:`, moves that window to the last workspace, and fullscreens it.
`/dynamic-resolution` makes the remote desktop match the monitor.

## Notes

- FreeRDP 3 is required (`/args-from` does not exist in 2.x).
- By default GNOME keeps its shortcuts (Super, workspace switching). Enable
  "Send all keys to the remote session" to forward them; GNOME asks once for
  permission, and `Super+Escape` gives the keys back.
- The session uses the primary monitor. To span all monitors, add `/multimon /f`
  to "Extra arguments", and in GNOME Settings → Multitasking set workspaces to
  switch on all displays; otherwise windows on the other monitors show on every
  workspace.
- Troubleshooting: `journalctl --user -f -o cat /usr/bin/gnome-shell`. A failed
  connection shows the client's last log lines in a notification.
