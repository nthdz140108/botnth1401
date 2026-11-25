use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use hmac::{Hmac, Mac};
use rand::{RngCore, rngs::OsRng};
use sha2::{Digest, Sha256};
pub fn random_token() -> String {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}
pub fn digest(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}
pub fn hash_password(s: &str) -> anyhow::Result<String> {
    if s.len() < 12 || s.len() > 1024 {
        anyhow::bail!("Password requires 12–1024 bytes");
    }
    Argon2::default()
        .hash_password(s.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!(e.to_string()))
}
pub fn verify_password(s: &str, h: &str) -> bool {
    PasswordHash::new(h).is_ok_and(|h| Argon2::default().verify_password(s.as_bytes(), &h).is_ok())
}
pub fn totp(secret: &[u8], step: u64) -> String {
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(secret).expect("HMAC key");
    mac.update(&step.to_be_bytes());
    let b = mac.finalize().into_bytes();
    let o = (b[19] & 15) as usize;
    let n = u32::from_be_bytes(b[o..o + 4].try_into().unwrap()) & 0x7fff_ffff;
    format!("{:06}", n % 1_000_000)
}
