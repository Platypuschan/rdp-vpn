import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as CheckBox from 'resource:///org/gnome/shell/ui/checkBox.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {lookupPassword, storePassword} from './secret.js';

const State = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
};

// Native binaries, preferred order. SDL is a native Wayland client; the
// unsuffixed names are Fedora's, the "3" ones Debian's.
const CLIENT_BINARIES = [
    'sdl-freerdp', 'sdl-freerdp3',
    'xfreerdp', 'xfreerdp3',
    'wlfreerdp', 'wlfreerdp3',
];
const FLATPAK_APP = 'com.freerdp.FreeRDP';

const LOG_TAIL_LINES = 6;
const KILL_TIMEOUT_SECONDS = 3;
const SIGTERM = 15;
// With /multimon, windows are watched for this long for their title.
const CANDIDATE_TIMEOUT_US = 15 * GLib.USEC_PER_SEC;

// Run inside a container, where the host cannot look for binaries: picks the
// first client that exists there and hands it the remaining arguments.
const CONTAINER_LAUNCHER = `
for client in ${CLIENT_BINARIES.join(' ')}; do
    command -v "$client" >/dev/null 2>&1 && exec "$client" "$@"
done
echo "No FreeRDP client is installed in this container." >&2
exit 127`;

/** Returns the argv prefix that starts the client; throws with a user-facing message. */
function findClient(custom, container) {
    let client = null;
    if (custom.trim()) {
        try {
            [, client] = GLib.shell_parse_argv(custom);
        } catch (e) {
            throw new Error(`Invalid client command: ${e.message}`);
        }
    }

    if (container) {
        if (!GLib.find_program_in_path('distrobox'))
            throw new Error('A distrobox container is configured, but distrobox is not installed.');
        // --no-tty keeps stdin a plain pipe for /args-from:stdin.
        return [
            'distrobox', 'enter', '--no-tty', '--name', container, '--',
            ...client ?? ['sh', '-c', CONTAINER_LAUNCHER, 'sh'],
        ];
    }

    if (client)
        return client;

    for (const name of CLIENT_BINARIES) {
        const path = GLib.find_program_in_path(name);
        if (path)
            return [path];
    }

    if (GLib.find_program_in_path('flatpak')) {
        const roots = [
            '/var/lib/flatpak',
            GLib.build_filenamev([GLib.get_user_data_dir(), 'flatpak']),
        ];
        for (const root of roots) {
            const dir = GLib.build_filenamev([root, 'app', FLATPAK_APP]);
            if (GLib.file_test(dir, GLib.FileTest.EXISTS))
                return ['flatpak', 'run', FLATPAK_APP];
        }
    }

    throw new Error(
        `No FreeRDP client found. Install one, e.g. "flatpak install flathub ${FLATPAK_APP}".`);
}

const PasswordDialog = GObject.registerClass(
class PasswordDialog extends ModalDialog.ModalDialog {
    _init(target, onDone) {
        super._init({styleClass: 'prompt-dialog'});
        this._onDone = onDone;

        const content = new Dialog.MessageDialogContent({
            title: 'RDP password',
            description: target,
        });
        this.contentLayout.add_child(content);

        this._entry = new St.PasswordEntry({
            style_class: 'prompt-dialog-password-entry',
            can_focus: true,
            x_expand: true,
        });
        this._entry.clutter_text.connect('activate', () => this.finish(true));
        content.add_child(this._entry);

        this._remember = new CheckBox.CheckBox('Save password in the keyring');
        content.add_child(this._remember);

        this.setInitialKeyFocus(this._entry);
        this.setButtons([
            {
                label: 'Cancel',
                action: () => this.finish(false),
                key: Clutter.KEY_Escape,
            },
            {
                label: 'Connect',
                action: () => this.finish(true),
                default: true,
            },
        ]);
    }

    finish(accepted) {
        if (!this._onDone)
            return;

        const onDone = this._onDone;
        this._onDone = null;
        const result = accepted
            ? {password: this._entry.text, remember: this._remember.checked}
            : null;
        this.close();
        onDone(result);
    }
});

class RdpSession {
    constructor(settings, onChanged) {
        this._settings = settings;
        this._onChanged = onChanged;
        this._state = State.IDLE;
        this._cancellable = new Gio.Cancellable();

        this._proc = null;
        this._log = [];
        this._title = null;
        this._multiMonitor = false;
        this._stopRequested = false;
        this._killTimeoutId = 0;

        this._window = null;
        this._windowSignals = [];
        this._rdpWorkspace = null;
        this._hadWindow = false;
        this._candidates = [];
        this._previousWorkspace = null;
        this._dialog = null;

        this._windowCreatedId = global.display.connect(
            'window-created', (_display, window) => this._onWindowCreated(window));
    }

    get state() {
        return this._state;
    }

    get host() {
        return this._settings.get_string('host').trim();
    }

    get onRdpWorkspace() {
        return this._window !== null &&
            this._window.get_workspace() === global.workspace_manager.get_active_workspace();
    }

    async connect() {
        if (this._state !== State.IDLE)
            return;

        const host = this.host;
        if (!host) {
            Main.notifyError('RDP Workspace', 'No host configured. Open the extension settings first.');
            return;
        }

        let client;
        try {
            client = findClient(
                this._settings.get_string('client-command'),
                this._settings.get_string('distrobox-container').trim());
        } catch (e) {
            Main.notifyError('RDP Workspace', e.message);
            return;
        }

        this._setState(State.CONNECTING);

        // Without a user name the client shows its own credential dialog.
        const username = this._settings.get_string('username').trim();
        let password = null;
        if (username) {
            try {
                password = await lookupPassword(host, username, this._cancellable);
            } catch (e) {
                if (this._cancellable.is_cancelled())
                    return;
                console.warn(`RDP Workspace: keyring lookup failed: ${e.message}`);
            }

            if (password === null) {
                const answer = await this._askPassword(`${username}@${host}`);
                if (this._cancellable.is_cancelled())
                    return;
                if (!answer) {
                    this._setState(State.IDLE);
                    return;
                }
                password = answer.password;
                if (answer.remember) {
                    storePassword(host, username, password).catch(e =>
                        console.warn(`RDP Workspace: could not store password: ${e.message}`));
                }
            }
        }

        let args;
        try {
            args = this._buildArgs(host, username, password);
        } catch (e) {
            Main.notifyError('RDP Workspace', e.message);
            this._setState(State.IDLE);
            return;
        }

        try {
            this._spawn(client, args);
        } catch (e) {
            Main.notifyError('RDP Workspace', `Could not start ${client[0]}: ${e.message}`);
            this._proc = null;
            this._setState(State.IDLE);
        }
    }

    disconnect() {
        if (this._dialog) {
            this._dialog.finish(false);
            return;
        }
        if (!this._proc)
            return;

        this._stopRequested = true;
        // Closing the window lets the client log off the RDP channel cleanly.
        if (this._window)
            this._window.delete(global.get_current_time());
        else
            this._proc.send_signal(SIGTERM);

        if (!this._killTimeoutId) {
            const proc = this._proc;
            this._killTimeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, KILL_TIMEOUT_SECONDS, () => {
                    this._killTimeoutId = 0;
                    proc.force_exit();
                    return GLib.SOURCE_REMOVE;
                });
        }
    }

    toggleWorkspace() {
        if (!this._window)
            return;

        const workspaceManager = global.workspace_manager;
        const active = workspaceManager.get_active_workspace();
        const rdpWorkspace = this._window.get_workspace();

        if (active !== rdpWorkspace) {
            this._previousWorkspace = active;
            Main.activateWindow(this._window);
            return;
        }

        this._leaveWorkspace(rdpWorkspace);
    }

    destroy() {
        this._cancellable.cancel();
        global.display.disconnect(this._windowCreatedId);
        this._dropCandidates();
        // Killing a "distrobox enter" or "flatpak run" wrapper does not
        // reliably end the client behind it; closing its window does.
        this._window?.delete(global.get_current_time());
        this._untrackWindow();

        if (this._dialog) {
            this._dialog.finish(false);
            this._dialog = null;
        }
        if (this._killTimeoutId) {
            GLib.source_remove(this._killTimeoutId);
            this._killTimeoutId = 0;
        }
        if (this._proc) {
            this._proc.force_exit();
            this._proc = null;
        }
        this._onChanged = null;
    }

    _setState(state) {
        if (this._state === state)
            return;
        this._state = state;
        this._onChanged?.();
    }

    _askPassword(target) {
        return new Promise(resolve => {
            const dialog = new PasswordDialog(target, result => {
                this._dialog = null;
                resolve(result);
            });
            this._dialog = dialog;
            // A dialog that never opened is not destroyed by close().
            if (!dialog.open()) {
                dialog.finish(false);
                dialog.destroy();
            }
        });
    }

    _buildArgs(host, username, password) {
        const s = this._settings;
        this._title = `${host} (RDP Workspace)`;

        let extraArgs = [];
        const extra = s.get_string('extra-args').trim();
        if (extra) {
            try {
                [, extraArgs] = GLib.shell_parse_argv(extra);
            } catch (e) {
                throw new Error(`Invalid extra arguments: ${e.message}`);
            }
        }
        // With /multimon (from the extra arguments) the client places and
        // fullscreens its window(s) across all monitors itself.
        this._multiMonitor = extraArgs.some(arg => arg.startsWith('/multimon'));

        const args = [
            `/v:${host}`,
            `/port:${s.get_int('port')}`,
            `/t:${this._title}`,
            s.get_boolean('clipboard') ? '+clipboard' : '-clipboard',
            s.get_boolean('grab-keyboard') ? '+grab-keyboard' : '-grab-keyboard',
        ];

        if (!this._multiMonitor) {
            const monitor = global.display.get_monitor_geometry(
                global.display.get_primary_monitor());
            // The shell fullscreens the window; this makes the remote desktop follow.
            args.push(`/size:${monitor.width}x${monitor.height}`, '/dynamic-resolution');
        }

        if (username)
            args.push(`/u:${username}`);
        const domain = s.get_string('domain').trim();
        if (domain)
            args.push(`/d:${domain}`);
        if (password !== null)
            args.push(`/p:${password}`);
        if (s.get_boolean('audio'))
            args.push('/sound');
        const certPolicy = s.get_string('cert-policy');
        if (certPolicy !== 'ask')
            args.push(`/cert:${certPolicy}`);

        args.push(...extraArgs);

        // /args-from:stdin takes one argument per line and stops at an empty one.
        if (args.some(arg => arg === '' || /[\r\n]/.test(arg)))
            throw new Error('Settings and password must not contain line breaks.');

        return args;
    }

    _spawn(client, args) {
        // The arguments include the password, so they go through stdin rather
        // than the command line, where every local user could read them.
        const proc = Gio.Subprocess.new(
            [...client, '/args-from:stdin'],
            Gio.SubprocessFlags.STDIN_PIPE |
            Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_MERGE);

        this._proc = proc;
        this._log = [];
        this._hadWindow = false;
        this._stopRequested = false;
        this._previousWorkspace = global.workspace_manager.get_active_workspace();

        const stdin = proc.get_stdin_pipe();
        const payload = new TextEncoder().encode(`${args.join('\n')}\n`);
        stdin.write_bytes_async(new GLib.Bytes(payload), GLib.PRIORITY_DEFAULT, null, (_s, res) => {
            try {
                stdin.write_bytes_finish(res);
            } catch (e) {
                console.warn(`RDP Workspace: writing arguments failed: ${e.message}`);
            }
            stdin.close_async(GLib.PRIORITY_DEFAULT, null, null);
        });

        this._readLog(new Gio.DataInputStream({
            base_stream: proc.get_stdout_pipe(),
            close_base_stream: true,
        }), this._log);

        proc.wait_async(null, (_p, res) => {
            try {
                proc.wait_finish(res);
            } catch {
                // Nothing to add; the exit is handled below either way.
            }
            this._onExited(proc);
        });
    }

    _readLog(stream, log) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (_s, res) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(res);
            } catch {
                return;
            }
            if (line === null)
                return;

            log.push(line);
            if (log.length > LOG_TAIL_LINES)
                log.shift();
            this._readLog(stream, log);
        });
    }

    _onExited(proc) {
        if (proc !== this._proc)
            return;

        const failed = !this._hadWindow && !this._stopRequested;
        const ended = this._hadWindow && !this._stopRequested;
        const details = this._log.join('\n');

        this._proc = null;
        this._dropCandidates();
        if (this._killTimeoutId) {
            GLib.source_remove(this._killTimeoutId);
            this._killTimeoutId = 0;
        }
        this._setState(State.IDLE);

        if (failed) {
            const status = proc.get_if_exited() ? proc.get_exit_status() : -1;
            Main.notifyError('RDP connection failed',
                details || `The client exited with status ${status}.`);
        } else if (ended) {
            Main.notify('RDP Workspace', `The session to ${this.host} has ended.`);
        }
    }

    // The client's window is recognised by the title passed with /t. On
    // Wayland the title is usually still unset at creation time, so new
    // windows are watched until one matches. With /multimon the SDL client
    // opens one window per monitor, so watching continues after the first.
    _onWindowCreated(window) {
        if (!this._proc || (this._window && !this._multiMonitor))
            return;

        if (window.get_title() === this._title) {
            this._adoptWindow(window);
            return;
        }

        const now = GLib.get_monotonic_time();
        this._candidates = this._candidates.filter(c => {
            if (now - c.since < CANDIDATE_TIMEOUT_US)
                return true;
            c.window.disconnect(c.id);
            return false;
        });

        const candidate = {window, since: now};
        candidate.id = window.connect('notify::title', () => {
            if (window.get_title() !== this._title)
                return;
            window.disconnect(candidate.id);
            this._candidates = this._candidates.filter(c => c !== candidate);
            this._adoptWindow(window);
        });
        this._candidates.push(candidate);
    }

    _dropCandidates() {
        for (const {window, id} of this._candidates)
            window.disconnect(id);
        this._candidates = [];
    }

    _adoptWindow(window) {
        // Further /multimon windows only join the RDP workspace.
        if (this._window) {
            if (window !== this._window && this._rdpWorkspace?.index() >= 0)
                window.change_workspace(this._rdpWorkspace);
            return;
        }

        if (!this._multiMonitor)
            this._dropCandidates();

        this._window = window;
        this._hadWindow = true;
        this._rdpWorkspace = null;
        this._windowSignals = [
            window.connect('unmanaged', () => this._onWindowGone()),
            // Cached because the window has no workspace left by the time
            // "unmanaged" is emitted.
            window.connect('workspace-changed', () => {
                this._rdpWorkspace = window.get_workspace() ?? this._rdpWorkspace;
            }),
        ];

        const workspaceManager = global.workspace_manager;
        // With dynamic workspaces the last one is the empty spare, which
        // becomes a permanent workspace as soon as a window lives on it.
        window.change_workspace_by_index(workspaceManager.get_n_workspaces() - 1, false);
        if (!this._multiMonitor) {
            window.move_to_monitor(global.display.get_primary_monitor());
            window.make_fullscreen();
        }
        this._rdpWorkspace = window.get_workspace();

        if (this._settings.get_boolean('switch-on-connect')) {
            const active = workspaceManager.get_active_workspace();
            if (active !== window.get_workspace())
                this._previousWorkspace = active;
            Main.activateWindow(window);
        }

        this._setState(State.CONNECTED);
    }

    _untrackWindow() {
        if (!this._window)
            return;
        for (const id of this._windowSignals)
            this._window.disconnect(id);
        this._windowSignals = [];
        this._window = null;
    }

    _onWindowGone() {
        const rdpWorkspace = this._rdpWorkspace;
        this._rdpWorkspace = null;
        this._untrackWindow();

        if (rdpWorkspace && rdpWorkspace === global.workspace_manager.get_active_workspace())
            this._leaveWorkspace(rdpWorkspace);

        // The process normally exits right after; until then a replacement
        // window (some clients recreate theirs) is picked up again.
        if (this._proc)
            this._setState(State.CONNECTING);
    }

    _leaveWorkspace(rdpWorkspace) {
        let target = this._previousWorkspace;
        // index() is -1 once a workspace has been removed.
        if (!target || target.index() < 0 || target === rdpWorkspace)
            target = global.workspace_manager.get_workspace_by_index(0);
        if (target && target !== rdpWorkspace)
            target.activate(global.get_current_time());
    }
}

export default class RdpWorkspaceExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._session = new RdpSession(this._settings, () => this._sync());

        this._indicator = new PanelMenu.Button(0.0, 'RDP Workspace', false);
        this._icon = new St.Icon({
            icon_name: 'computer-symbolic',
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(this._icon);

        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._indicator.menu.addMenuItem(this._statusItem);
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._connectItem = this._indicator.menu.addAction('', () => {
            if (this._session.state === State.IDLE)
                this._session.connect();
            else
                this._session.disconnect();
        });
        this._workspaceItem = this._indicator.menu.addAction('', () => {
            this._session.toggleWorkspace();
        });
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._indicator.menu.addAction('Settings', () => this.openPreferences());
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._sync();
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        Main.wm.addKeybinding(
            'toggle-shortcut', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                if (this._session.state === State.IDLE)
                    this._session.connect();
                else
                    this._session.toggleWorkspace();
            });

        this._hostChangedId = this._settings.connect('changed::host', () => this._sync());
        this._sessionModeId = Main.sessionMode.connect('updated', () => this._sync());
        this._sync();

        if (this._settings.get_boolean('auto-connect') && !Main.sessionMode.isLocked) {
            if (Main.layoutManager._startingUp) {
                this._startupId = Main.layoutManager.connect('startup-complete', () => {
                    Main.layoutManager.disconnect(this._startupId);
                    this._startupId = 0;
                    this._session.connect();
                });
            } else {
                this._session.connect();
            }
        }
    }

    // This extension also runs in the "unlock-dialog" session mode, because
    // disable() has to end the RDP session and locking the screen should not
    // do that. While locked, the indicator is hidden and the shortcut is
    // inactive (its action modes exclude the lock screen).
    disable() {
        if (this._startupId) {
            Main.layoutManager.disconnect(this._startupId);
            this._startupId = 0;
        }
        Main.sessionMode.disconnect(this._sessionModeId);
        this._settings.disconnect(this._hostChangedId);
        Main.wm.removeKeybinding('toggle-shortcut');

        this._session.destroy();
        this._session = null;

        this._indicator.destroy();
        this._indicator = null;
        this._icon = null;
        this._statusItem = null;
        this._connectItem = null;
        this._workspaceItem = null;
        this._settings = null;
    }

    _sync() {
        const session = this._session;
        const host = session.host || 'no host configured';

        this._indicator.visible = !Main.sessionMode.isLocked;
        this._icon.opacity = session.state === State.CONNECTED ? 255 : 128;

        switch (session.state) {
        case State.IDLE:
            this._statusItem.label.text = `Not connected (${host})`;
            this._connectItem.label.text = 'Connect';
            break;
        case State.CONNECTING:
            this._statusItem.label.text = `Connecting to ${host}…`;
            this._connectItem.label.text = 'Cancel';
            break;
        case State.CONNECTED:
            this._statusItem.label.text = `Connected to ${host}`;
            this._connectItem.label.text = 'Disconnect';
            break;
        }

        this._workspaceItem.visible = session.state === State.CONNECTED;
        this._workspaceItem.label.text = session.onRdpWorkspace
            ? 'Back to previous workspace'
            : 'Go to RDP workspace';
    }
}
