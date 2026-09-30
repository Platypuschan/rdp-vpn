import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {clearPassword, storePassword} from './secret.js';

const CERT_POLICIES = [
    ['tofu', 'Trust on first use'],
    ['ask', 'Ask (SDL client only)'],
    ['ignore', 'Ignore (insecure)'],
];

export default class RdpWorkspacePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const toast = title => window.add_toast(new Adw.Toast({title}));

        const entryRow = (key, title) => {
            const row = new Adw.EntryRow({title});
            settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };
        const switchRow = (key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        const page = new Adw.PreferencesPage();
        window.add(page);

        // Connection
        const connection = new Adw.PreferencesGroup({title: 'Connection'});
        page.add(connection);

        connection.add(entryRow('host', 'Host'));
        const portRow = Adw.SpinRow.new_with_range(1, 65535, 1);
        portRow.title = 'Port';
        settings.bind('port', portRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        connection.add(portRow);
        connection.add(entryRow('username', 'User name'));
        connection.add(entryRow('domain', 'Domain (optional)'));

        const credentials = () => [
            settings.get_string('host').trim(),
            settings.get_string('username').trim(),
        ];

        const passwordRow = new Adw.PasswordEntryRow({
            title: 'Password (stored in the keyring for this host and user)',
            show_apply_button: true,
        });
        passwordRow.connect('apply', () => {
            const [host, username] = credentials();
            if (!host || !username) {
                toast('Set host and user name first');
                return;
            }
            storePassword(host, username, passwordRow.text).then(() => {
                passwordRow.text = '';
                toast(`Password saved for ${username}@${host}`);
            }).catch(e => toast(`Could not save password: ${e.message}`));
        });
        const forgetButton = new Gtk.Button({
            icon_name: 'edit-delete-symbolic',
            tooltip_text: 'Remove the stored password',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        forgetButton.connect('clicked', () => {
            const [host, username] = credentials();
            clearPassword(host, username)
                .then(removed => toast(removed ? 'Password removed' : 'No password was stored'))
                .catch(e => toast(`Could not remove password: ${e.message}`));
        });
        passwordRow.add_suffix(forgetButton);
        connection.add(passwordRow);

        const certRow = new Adw.ComboRow({
            title: 'Unknown server certificate',
            model: Gtk.StringList.new(CERT_POLICIES.map(([, label]) => label)),
        });
        const policyIndex = () => Math.max(0,
            CERT_POLICIES.findIndex(([id]) => id === settings.get_string('cert-policy')));
        certRow.selected = policyIndex();
        certRow.connect('notify::selected', () => {
            const [id] = CERT_POLICIES[certRow.selected];
            if (settings.get_string('cert-policy') !== id)
                settings.set_string('cert-policy', id);
        });
        settings.connect('changed::cert-policy', () => {
            certRow.selected = policyIndex();
        });
        connection.add(certRow);

        // Behaviour
        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        page.add(behaviour);

        behaviour.add(switchRow('switch-on-connect', 'Switch to the RDP workspace on connect'));
        behaviour.add(switchRow('auto-connect', 'Connect at login'));
        behaviour.add(switchRow('grab-keyboard', 'Send all keys to the remote session',
            'Includes Super and other GNOME shortcuts. Super+Escape releases the grab.'));
        behaviour.add(switchRow('clipboard', 'Share clipboard'));
        behaviour.add(switchRow('audio', 'Play remote audio'));

        const shortcutRow = new Adw.EntryRow({
            title: 'Toggle shortcut, e.g. <Super><Alt>r (empty disables)',
            show_apply_button: true,
            text: settings.get_strv('toggle-shortcut')[0] ?? '',
        });
        shortcutRow.connect('apply', () => {
            const accel = shortcutRow.text.trim();
            if (!accel) {
                settings.set_strv('toggle-shortcut', []);
                return;
            }
            const [ok, keyval] = Gtk.accelerator_parse(accel);
            if (ok && keyval !== 0)
                settings.set_strv('toggle-shortcut', [accel]);
            else
                toast(`"${accel}" is not a valid shortcut`);
        });
        behaviour.add(shortcutRow);

        // Client
        const client = new Adw.PreferencesGroup({
            title: 'FreeRDP client',
            description: 'Needs FreeRDP 3. Left empty, the command is detected: ' +
                'sdl-freerdp, xfreerdp or wlfreerdp on the PATH, then the ' +
                'com.freerdp.FreeRDP Flatpak. With a distrobox container set, ' +
                'the client is looked up and started inside that container.',
        });
        page.add(client);

        client.add(entryRow('distrobox-container', 'Distrobox container (empty: run on the host)'));
        client.add(entryRow('client-command', 'Client command'));
        client.add(entryRow('extra-args', 'Extra arguments, e.g. /gfx:avc444 /microphone'));
    }
}
