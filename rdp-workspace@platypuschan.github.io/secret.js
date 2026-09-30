// Keyring access shared by extension.js (shell process) and prefs.js (GTK
// process). Must not import anything shell- or GTK-specific.

import Secret from 'gi://Secret';

const SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.rdp-workspace',
    Secret.SchemaFlags.NONE,
    {
        host: Secret.SchemaAttributeType.STRING,
        username: Secret.SchemaAttributeType.STRING,
    });

/** Resolves to the stored password, or null if there is none. */
export function lookupPassword(host, username, cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(SCHEMA, {host, username}, cancellable, (_src, res) => {
            try {
                resolve(Secret.password_lookup_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function storePassword(host, username, password) {
    return new Promise((resolve, reject) => {
        Secret.password_store(
            SCHEMA, {host, username}, Secret.COLLECTION_DEFAULT,
            `RDP Workspace: ${username}@${host}`, password, null,
            (_src, res) => {
                try {
                    resolve(Secret.password_store_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/** Resolves to true if a password was removed. */
export function clearPassword(host, username) {
    return new Promise((resolve, reject) => {
        Secret.password_clear(SCHEMA, {host, username}, null, (_src, res) => {
            try {
                resolve(Secret.password_clear_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}
