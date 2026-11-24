//! Hardware-accelerated Zalo Web cryptography & compression (`API_TYPE = 30`, `API_VERSION = 671`).
//!
//! Implements all 4 Zalo protocol layers with exact byte-level parity against `src/api-zalo/utils.js`:
//! 1. `get_sign_key`: lexicographically sorted keys + `"zsecure"` + lowercase MD5 hex.
//! 2. `ParamsEncryptor`: `zcid` via static key `3FC4F0D2AB50057BCE0D90D9187A22B1`, ephemeral 32-byte `enk`
//!    from even/odd slices of `MD5(zcid_ext)` and `zcid`.
//! 3. `encode_aes_cbc` / `decode_aes_cbc`: Base64 `secretKey` (`zpw_enk`), Zero IV `[0u8; 16]`, PKCS#7,
//!    dynamically dispatching AES-128, AES-192, or AES-256 based on decoded key byte length.
//! 4. `decode_ws_event_payload`: **16-byte IV (`typenum::U16`)** + 16-byte AAD + AES-GCM-128/256 + SIMD `flate2`.

use std::collections::BTreeMap;
use std::io::{Read, Write};

use aes::{Aes128, Aes192, Aes256};
use aes_gcm::aead::{Aead, KeyInit as GcmKeyInit, Payload};
use aes_gcm::{AesGcm, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use cipher::block_padding::Pkcs7;
use cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use flate2::Compression;
use flate2::read::{DeflateDecoder, GzDecoder, ZlibDecoder};
use flate2::write::ZlibEncoder;
use md5::{Digest, Md5};
use rand::Rng;
use typenum::U16;
use uuid::Uuid;

use crate::error::ZaloCryptoError;

type Aes128CbcEnc = cbc::Encryptor<Aes128>;
type Aes128CbcDec = cbc::Decryptor<Aes128>;
type Aes192CbcEnc = cbc::Encryptor<Aes192>;
type Aes192CbcDec = cbc::Decryptor<Aes192>;
type Aes256CbcEnc = cbc::Encryptor<Aes256>;
type Aes256CbcDec = cbc::Decryptor<Aes256>;

/// CRITICAL PROTOCOL TYPE: Zalo WebSocket uses 16-byte IVs (`U16`), NOT standard 12-byte (`U12`)!
pub type ZaloAes128Gcm = AesGcm<Aes128, U16>;
pub type ZaloAes192Gcm = AesGcm<Aes192, U16>;
pub type ZaloAes256Gcm = AesGcm<Aes256, U16>;

const ZCID_STATIC_KEY: &[u8; 32] = b"3FC4F0D2AB50057BCE0D90D9187A22B1";
const ZERO_IV: [u8; 16] = [0u8; 16];

/// Computes lowercase MD5 hex digest of arbitrary bytes.
#[inline]
pub fn md5_hex_lower(bytes: &[u8]) -> String {
    let mut hasher = Md5::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Computes uppercase MD5 hex digest of arbitrary bytes.
#[inline]
pub fn md5_hex_upper(bytes: &[u8]) -> String {
    md5_hex_lower(bytes).to_ascii_uppercase()
}

/// Generates a Zalo Web IMEI bound to `user_agent`: `<uuidv4>-<md5_lower(user_agent)>`.
pub fn generate_zalo_imei(user_agent: &str) -> String {
    format!("{}-{}", Uuid::new_v4(), md5_hex_lower(user_agent.as_bytes()))
}

/// Computes Zalo `signkey` (`"zsecure" + api_type + sorted_param_values` -> lowercase MD5 hex).
pub fn get_sign_key<K: AsRef<str>, V: AsRef<str>>(
    endpoint_type: &str,
    params: impl IntoIterator<Item = (K, V)>,
) -> String {
    let mut sorted = BTreeMap::new();
    for (k, v) in params {
        sorted.insert(k.as_ref().to_string(), v.as_ref().to_string());
    }
    let mut buf = String::with_capacity(64);
    buf.push_str("zsecure");
    buf.push_str(endpoint_type);
    for val in sorted.values() {
        buf.push_str(val);
    }
    md5_hex_lower(buf.as_bytes())
}

fn aes_cbc_encrypt_raw(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, ZaloCryptoError> {
    match key.len() {
        16 => Ok(Aes128CbcEnc::new_from_slices(key, &ZERO_IV)
            .map_err(|_| ZaloCryptoError::UnsupportedKeySize(key.len()))?
            .encrypt_padded_vec_mut::<Pkcs7>(plaintext)),
        24 => Ok(Aes192CbcEnc::new_from_slices(key, &ZERO_IV)
            .map_err(|_| ZaloCryptoError::UnsupportedKeySize(key.len()))?
            .encrypt_padded_vec_mut::<Pkcs7>(plaintext)),
        32 => Ok(Aes256CbcEnc::new_from_slices(key, &ZERO_IV)
            .map_err(|_| ZaloCryptoError::UnsupportedKeySize(key.len()))?
            .encrypt_padded_vec_mut::<Pkcs7>(plaintext)),
        n => Err(ZaloCryptoError::UnsupportedKeySize(n)),
    }
}

fn aes_cbc_decrypt_raw(key: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, ZaloCryptoError> {
    match key.len() {
        16 => Aes128CbcDec::new_from_slices(key, &ZERO_IV)
            .map_err(|_| ZaloCryptoError::UnsupportedKeySize(key.len()))?
            .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
            .map_err(|_| ZaloCryptoError::CbcDecryptFailed),
        24 => Aes192CbcDec::new_from_slices(key, &ZERO_IV)
            .map_err(|_| ZaloCryptoError::UnsupportedKeySize(key.len()))?
            .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
            .map_err(|_| ZaloCryptoError::CbcDecryptFailed),
        32 => Aes256CbcDec::new_from_slices(key, &ZERO_IV)
            .map_err(|_| ZaloCryptoError::UnsupportedKeySize(key.len()))?
            .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
            .map_err(|_| ZaloCryptoError::CbcDecryptFailed),
        n => Err(ZaloCryptoError::UnsupportedKeySize(n)),
    }
}

/// Pre-login `ParamsEncryptor` (`utils.js:70-165`) used by `getLoginInfo` and `getServerInfo`.
#[derive(Debug, Clone)]
pub struct ParamsEncryptor {
    pub zcid: String,
    pub zcid_ext: String,
    pub enc_ver: &'static str,
    pub encrypt_key: String,
}

impl ParamsEncryptor {
    pub fn new(api_type: u32, imei: &str, first_launch_time_ms: i64) -> Result<Self, ZaloCryptoError> {
        let zcid_ext = random_hex_string(6, 12);
        Self::with_ext(api_type, imei, first_launch_time_ms, zcid_ext)
    }

    pub fn with_ext(
        api_type: u32,
        imei: &str,
        first_launch_time_ms: i64,
        zcid_ext: String,
    ) -> Result<Self, ZaloCryptoError> {
        if api_type == 0 || imei.trim().is_empty() || first_launch_time_ms <= 0 || zcid_ext.is_empty() {
            return Err(ZaloCryptoError::InvalidParamsEncryptor);
        }
        let msg = format!("{api_type},{imei},{first_launch_time_ms}");
        let zcid_bytes = aes_cbc_encrypt_raw(ZCID_STATIC_KEY, msg.as_bytes())?;
        let zcid = hex::encode_upper(zcid_bytes);

        let md5_upper = md5_hex_upper(zcid_ext.as_bytes());
        let (md5_even, _) = split_even_odd_chars(&md5_upper);
        let (zcid_even, mut zcid_odd) = split_even_odd_chars(&zcid);
        zcid_odd.reverse();

        if md5_even.len() < 8 || zcid_even.len() < 12 || zcid_odd.len() < 12 {
            return Err(ZaloCryptoError::InvalidParamsEncryptor);
        }

        let mut encrypt_key = String::with_capacity(32);
        encrypt_key.extend(&md5_even[..8]);
        encrypt_key.extend(&zcid_even[..12]);
        encrypt_key.extend(&zcid_odd[..12]);

        Ok(Self {
            zcid,
            zcid_ext,
            enc_ver: "v2",
            encrypt_key,
        })
    }

    /// Encrypts pre-login JSON string with UTF-8 `encrypt_key` -> Base64 ciphertext.
    pub fn encrypt_params_b64(&self, plaintext: &str) -> Result<String, ZaloCryptoError> {
        let ct = aes_cbc_encrypt_raw(self.encrypt_key.as_bytes(), plaintext.as_bytes())?;
        Ok(B64.encode(ct))
    }

    /// Decrypts `getLoginInfo` `data.data` (`decodeURIComponent` + Base64 + UTF-8 `encrypt_key` AES-CBC).
    pub fn decrypt_login_response(&self, encoded_data: &str) -> Result<String, ZaloCryptoError> {
        decode_utf8_key_aes_cbc(&self.encrypt_key, encoded_data)
    }
}

pub fn decode_utf8_key_aes_cbc(utf8_key: &str, encoded_data: &str) -> Result<String, ZaloCryptoError> {
    let url_decoded = urlencoding::decode(encoded_data)
        .map_err(ZaloCryptoError::UrlDecode)?;
    let ciphertext = B64.decode(url_decoded.trim().as_bytes())?;
    let plain = aes_cbc_decrypt_raw(utf8_key.as_bytes(), &ciphertext)?;
    String::from_utf8(plain).map_err(|_| ZaloCryptoError::CbcDecryptFailed)
}

/// Post-login REST encryption (`utils.js::encodeAES`): Base64 `secretKey` (`zpw_enk`) -> Base64 AES-CBC.
pub fn encode_aes_cbc(secret_key_b64: &str, plaintext: &str) -> Result<String, ZaloCryptoError> {
    let key = B64.decode(secret_key_b64.trim().as_bytes())?;
    let ct = aes_cbc_encrypt_raw(&key, plaintext.as_bytes())?;
    Ok(B64.encode(ct))
}

/// Post-login REST decryption (`utils.js::decodeAES`): `decodeURIComponent` + Base64 -> UTF-8 JSON.
pub fn decode_aes_cbc(secret_key_b64: &str, encoded_data: &str) -> Result<String, ZaloCryptoError> {
    let url_decoded = urlencoding::decode(encoded_data)?;
    let key = B64.decode(secret_key_b64.trim().as_bytes())?;
    let ct = B64.decode(url_decoded.trim().as_bytes())?;
    let plain = aes_cbc_decrypt_raw(&key, &ct)?;
    String::from_utf8(plain).map_err(|_| ZaloCryptoError::CbcDecryptFailed)
}

/// Decrypts and inflates a Zalo WebSocket event `data` field (`utils.js::decodeEventData`).
///
/// Wire layout after `decodeURIComponent` + Base64:
/// - `raw[0..16]`: 16-byte AES-GCM IV (`typenum::U16`)
/// - `raw[16..32]`: 16-byte Additional Authenticated Data (AAD)
/// - `raw[32..]`: Ciphertext + 16-byte GCM authentication tag (minimum total length = 48 bytes)
///
/// Plaintext inside GCM is zlib/deflate compressed (`pako.inflate`).
pub fn decode_ws_event_payload(
    encoded_uri_b64: &str,
    cipher_key_b64: &str,
) -> Result<Vec<u8>, ZaloCryptoError> {
    let url_decoded = urlencoding::decode(encoded_uri_b64)?;
    let raw = B64.decode(url_decoded.trim().as_bytes())?;
    if raw.len() < 48 {
        return Err(ZaloCryptoError::FrameTooShort(raw.len()));
    }

    let iv = Nonce::<U16>::from_slice(&raw[0..16]);
    let aad = &raw[16..32];
    let ciphertext_and_tag = &raw[32..];
    let key_bytes = B64.decode(cipher_key_b64.trim().as_bytes())?;

    let compressed = match key_bytes.len() {
        16 => ZaloAes128Gcm::new_from_slice(&key_bytes)
            .map_err(|_| ZaloCryptoError::UnsupportedKeySize(16))?
            .decrypt(
                iv,
                Payload {
                    msg: ciphertext_and_tag,
                    aad,
                },
            )
            .map_err(|_| ZaloCryptoError::GcmAuthFailed)?,
        24 => ZaloAes192Gcm::new_from_slice(&key_bytes)
            .map_err(|_| ZaloCryptoError::UnsupportedKeySize(24))?
            .decrypt(
                iv,
                Payload {
                    msg: ciphertext_and_tag,
                    aad,
                },
            )
            .map_err(|_| ZaloCryptoError::GcmAuthFailed)?,
        32 => ZaloAes256Gcm::new_from_slice(&key_bytes)
            .map_err(|_| ZaloCryptoError::UnsupportedKeySize(32))?
            .decrypt(
                iv,
                Payload {
                    msg: ciphertext_and_tag,
                    aad,
                },
            )
            .map_err(|_| ZaloCryptoError::GcmAuthFailed)?,
        n => return Err(ZaloCryptoError::UnsupportedKeySize(n)),
    };

    inflate_zlib_or_raw(&compressed)
}

/// Symmetric encoder for testing and synthetic WS frame generation (`zlib` + `AesGcm<_, U16>`).
pub fn encode_ws_event_payload(
    plaintext: &[u8],
    cipher_key_b64: &str,
    iv_16: &[u8; 16],
    aad_16: &[u8; 16],
) -> Result<String, ZaloCryptoError> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(plaintext)
        .map_err(|e| ZaloCryptoError::Decompress(e.to_string()))?;
    let compressed = encoder
        .finish()
        .map_err(|e| ZaloCryptoError::Decompress(e.to_string()))?;

    let key_bytes = B64.decode(cipher_key_b64.trim().as_bytes())?;
    let nonce = Nonce::<U16>::from_slice(iv_16);
    let ct_and_tag = match key_bytes.len() {
        16 => ZaloAes128Gcm::new_from_slice(&key_bytes)
            .map_err(|_| ZaloCryptoError::UnsupportedKeySize(16))?
            .encrypt(
                nonce,
                Payload {
                    msg: &compressed,
                    aad: aad_16,
                },
            )
            .map_err(|_| ZaloCryptoError::GcmAuthFailed)?,
        24 => ZaloAes192Gcm::new_from_slice(&key_bytes)
            .map_err(|_| ZaloCryptoError::UnsupportedKeySize(24))?
            .encrypt(
                nonce,
                Payload {
                    msg: &compressed,
                    aad: aad_16,
                },
            )
            .map_err(|_| ZaloCryptoError::GcmAuthFailed)?,
        32 => ZaloAes256Gcm::new_from_slice(&key_bytes)
            .map_err(|_| ZaloCryptoError::UnsupportedKeySize(32))?
            .encrypt(
                nonce,
                Payload {
                    msg: &compressed,
                    aad: aad_16,
                },
            )
            .map_err(|_| ZaloCryptoError::GcmAuthFailed)?,
        n => return Err(ZaloCryptoError::UnsupportedKeySize(n)),
    };

    let mut frame = Vec::with_capacity(32 + ct_and_tag.len());
    frame.extend_from_slice(iv_16);
    frame.extend_from_slice(aad_16);
    frame.extend_from_slice(&ct_and_tag);
    Ok(B64.encode(frame))
}

/// Handles the gzip and zlib wrappers accepted by `pako.inflate`, plus raw deflate.
fn inflate_zlib_or_raw(compressed: &[u8]) -> Result<Vec<u8>, ZaloCryptoError> {
    let mut out = Vec::with_capacity(compressed.len().saturating_mul(3).max(256));
    if compressed.starts_with(&[0x1f, 0x8b]) {
        let mut gz = GzDecoder::new(compressed);
        gz.read_to_end(&mut out)
            .map_err(|e| ZaloCryptoError::Decompress(format!("gzip: {e}")))?;
        return Ok(out);
    }
    let looks_like_zlib = compressed.len() >= 2
        && (compressed[0] & 0x0F) == 0x08
        && ((u16::from(compressed[0]) << 8 | u16::from(compressed[1])) % 31 == 0);

    if looks_like_zlib {
        let mut z = ZlibDecoder::new(compressed);
        if z.read_to_end(&mut out).is_ok() {
            return Ok(out);
        }
        out.clear();
    }

    let mut d = DeflateDecoder::new(compressed);
    d.read_to_end(&mut out)
        .map_err(|e| ZaloCryptoError::Decompress(format!("raw deflate: {e}")))?;
    Ok(out)
}

fn split_even_odd_chars(input: &str) -> (Vec<char>, Vec<char>) {
    let mut even = Vec::with_capacity(input.len().div_ceil(2));
    let mut odd = Vec::with_capacity(input.len() / 2);
    for (idx, ch) in input.chars().enumerate() {
        if idx % 2 == 0 {
            even.push(ch);
        } else {
            odd.push(ch);
        }
    }
    (even, odd)
}

fn random_hex_string(min_len: usize, max_len: usize) -> String {
    let mut rng = rand::thread_rng();
    let len = rng.gen_range(min_len..=max_len);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    (0..len)
        .map(|_| HEX[rng.gen_range(0..16)] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_key_sorts_lexicographically_and_hashes_md5() {
        let sign = get_sign_key(
            "getserverinfo",
            [
                ("type", "30"),
                ("imei", "test-imei-123"),
                ("client_version", "671"),
                ("computer_name", "Web"),
            ],
        );
        // Lexicographical order: client_version, computer_name, imei, type
        // "zsecuregetserverinfo671Webtest-imei-12330"
        let expected = md5_hex_lower(b"zsecuregetserverinfo671Webtest-imei-12330");
        assert_eq!(sign, expected);
        assert_eq!(sign.len(), 32);
    }

    #[test]
    fn params_encryptor_produces_32_byte_key_and_roundtrips() {
        let enc = ParamsEncryptor::with_ext(
            30,
            "11111111-2222-4333-8444-555555555555-abcdef0123456789abcdef0123456789",
            1_730_000_000_000,
            "a1b2c3d4".to_string(),
        )
        .expect("encryptor");
        assert_eq!(enc.encrypt_key.len(), 32);

        let payload = r#"{"computer_name":"Web","imei":"test","language":"vi","ts":1730000000000}"#;
        let b64 = enc.encrypt_params_b64(payload).expect("encrypt");
        let url_encoded = urlencoding::encode(&b64);
        let decrypted = enc.decrypt_login_response(&url_encoded).expect("decrypt");
        assert_eq!(decrypted, payload);
    }

    #[test]
    fn post_login_aes_128_192_and_256_cbc_roundtrip() {
        for key_len in [16usize, 24usize, 32usize] {
            let key_b64 = B64.encode(vec![0x42u8; key_len]);
            let msg = r#"{"toid":"84987654321","message":"Xin chào tiếng Việt 🚀"}"#;
            let ct = encode_aes_cbc(&key_b64, msg).expect("encode");
            let pt = decode_aes_cbc(&key_b64, &urlencoding::encode(&ct)).expect("decode");
            assert_eq!(pt, msg);
        }
    }

    #[test]
    fn ws_aes_gcm_16_byte_iv_128_192_256_and_zlib_roundtrip() {
        for key_len in [16usize, 24usize, 32usize] {
            let key_b64 = B64.encode(vec![0x7Au8; key_len]);
            let iv = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
            let aad = *b"zalo-aad-16bytes";
            let sample = br#"{"data":{"msgs":[{"msgId":"998877","content":"!ping"}]}}"#;

            let encoded = encode_ws_event_payload(sample, &key_b64, &iv, &aad).expect("encode gcm");
            let url_encoded = urlencoding::encode(&encoded);
            let decoded = decode_ws_event_payload(&url_encoded, &key_b64).expect("decode gcm");
            assert_eq!(decoded, sample);
        }
    }

    #[test]
    fn ws_inflate_accepts_gzip_payload_supported_by_pako_inflate() {
        let sample = br#"{"data":{"groupMsgs":[{"content":"!ping"}]}}"#;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(sample).unwrap();
        let compressed = encoder.finish().unwrap();
        assert_eq!(inflate_zlib_or_raw(&compressed).unwrap(), sample);
    }
}
