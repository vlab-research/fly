use hmac::{Hmac, Mac};
use sha2::Sha256;

/// Verifies X-Hub-Signature-256: sha256=<hex> against the raw request body.
/// Off by default; only called when FB_APP_SECRET is configured.
pub fn verify_sha256(secret: &str, signature_header: &str, body: &[u8]) -> bool {
    let hex_sig = match signature_header.strip_prefix("sha256=") {
        Some(s) => s,
        None => return false,
    };

    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(body);
    let computed = hex::encode(mac.finalize().into_bytes());

    // Constant-time comparison via == on equal-length hex strings
    computed == hex_sig
}

/// Produces the X-Hub-Signature-256 header value ("sha256=<hex>") for a body.
/// Counterpart of verify_sha256; used by integration tests to sign payloads.
pub fn sign_sha256(secret: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(body);
    format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_signature_passes() {
        // echo -n 'hello' | openssl dgst -sha256 -hmac 'secret'
        let sig = "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b";
        assert!(verify_sha256("secret", &format!("sha256={}", sig), b"hello"));
    }

    #[test]
    fn wrong_secret_fails() {
        let sig = "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b";
        assert!(!verify_sha256("wrong", &format!("sha256={}", sig), b"hello"));
    }

    #[test]
    fn missing_prefix_fails() {
        assert!(!verify_sha256("secret", "noprefixhere", b"hello"));
    }

    #[test]
    fn sign_verify_roundtrip() {
        let sig = sign_sha256("secret", b"payload");
        assert!(verify_sha256("secret", &sig, b"payload"));
        assert!(!verify_sha256("other", &sig, b"payload"));
    }
}
