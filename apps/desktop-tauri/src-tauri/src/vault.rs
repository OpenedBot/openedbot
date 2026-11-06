//! Where the session is persisted: the OS keystore through the `keyring` crate
//! (Keychain on macOS), one entry per API origin.
//!
//! There is no file fallback on purpose. Without a keystore (Keychain locked or
//! refused, Linux without Secret Service) the session lives in memory only
//! (`auth.rs`): a refresh token in clear on disk would outlive the session and
//! is worse than asking the user to sign in again.

use sha2::{Digest, Sha256};
use url::Url;

#[derive(Debug, thiserror::Error)]
#[error("the keystore is unavailable ({0})")]
pub struct VaultError(pub String);

pub trait Vault: Send + Sync + 'static {
    fn load(&self) -> Result<Option<String>, VaultError>;
    fn save(&self, secret: &str) -> Result<(), VaultError>;
    fn clear(&self) -> Result<(), VaultError>;
}

/// The Keychain item of one API: service = the app's bundle identifier (so the
/// prototype never reads the Electron app's session), account = the API origin.
pub struct KeychainVault {
    service: String,
    account: String,
}

impl KeychainVault {
    pub fn new(service: &str, api_origin: &str) -> Self {
        Self { service: service.to_string(), account: account_for(api_origin) }
    }

    fn entry(&self) -> Result<keyring::Entry, VaultError> {
        keyring::Entry::new(&self.service, &self.account).map_err(|error| VaultError(kind(&error)))
    }
}

/// The account name for an API origin. The protocol is part of it: `http://`
/// and `https://` on one host are two issuers, and a refresh token must never
/// travel in clear to the one that did not issue it.
pub fn account_for(api_origin: &str) -> String {
    let readable = Url::parse(api_origin)
        .ok()
        .map(|url| format!("{}-{}", url.scheme(), url.host_str().unwrap_or("none")))
        .unwrap_or_else(|| "invalid".into());
    let digest = Sha256::digest(api_origin.as_bytes());
    let hex: String = digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect();
    format!("tokens-{readable}-{hex}")
}

/// The error kind only: a keyring error may quote the attribute values.
fn kind(error: &keyring::Error) -> String {
    match error {
        keyring::Error::NoEntry => "no entry".into(),
        keyring::Error::NoStorageAccess(_) => "no storage access".into(),
        keyring::Error::PlatformFailure(_) => "platform failure".into(),
        keyring::Error::BadEncoding(_) => "bad encoding".into(),
        keyring::Error::TooLong(..) => "too long".into(),
        keyring::Error::Invalid(..) => "invalid attribute".into(),
        keyring::Error::Ambiguous(_) => "ambiguous".into(),
        _ => "unknown".into(),
    }
}

impl Vault for KeychainVault {
    fn load(&self) -> Result<Option<String>, VaultError> {
        match self.entry()?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(VaultError(kind(&error))),
        }
    }

    fn save(&self, secret: &str) -> Result<(), VaultError> {
        self.entry()?.set_password(secret).map_err(|error| VaultError(kind(&error)))
    }

    fn clear(&self) -> Result<(), VaultError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(VaultError(kind(&error))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_account_per_origin_protocol_included() {
        let https = account_for("https://api.openedbot.app");
        let http = account_for("http://api.openedbot.app");
        assert_ne!(https, http);
        assert!(https.starts_with("tokens-https-api.openedbot.app-"));
        assert_eq!(account_for("http://127.0.0.1:8790"), account_for("http://127.0.0.1:8790"));
        assert_ne!(account_for("http://127.0.0.1:8790"), account_for("http://127.0.0.1:8791"));
    }
}
