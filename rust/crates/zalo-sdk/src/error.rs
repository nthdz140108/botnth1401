use thiserror::Error;
use url::Url;

/// Canonical error type across `zalo-sdk` with retry classification and delivery-rejection tagging.
#[derive(Debug, Error)]
pub enum ZaloApiError {
    #[error("Missing required credentials field: {0}")]
    MissingCredentials(&'static str),

    #[error("Invalid cookie format: {0}")]
    InvalidCookie(String),

    #[error("Invalid or untrusted Zalo endpoint ({label}): {reason}")]
    InvalidEndpoint { label: String, reason: String },

    #[error("Cryptography error: {0}")]
    Crypto(#[from] ZaloCryptoError),

    #[error("HTTP transport failed ({endpoint}): {message}")]
    HttpTransport {
        endpoint: String,
        status: Option<u16>,
        retryable: bool,
        message: String,
    },

    #[error("Zalo API error (code={code}, status={status:?}): {message}")]
    ApiRejected {
        code: i64,
        status: Option<u16>,
        message: String,
        delivery_rejection: bool,
    },

    #[error("Upload callback timed out for fileId={file_id} after {timeout_ms}ms")]
    UploadCallbackTimeout { file_id: String, timeout_ms: u64 },

    #[error("WebSocket protocol error: {0}")]
    WebSocket(String),

    #[error("Duplicate Zalo web session opened elsewhere (code 3000)")]
    DuplicateConnection,

    #[error("Invalid parameter: {0}")]
    InvalidParam(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

impl ZaloApiError {
    pub fn api_rejected(code: i64, status: Option<u16>, message: impl Into<String>) -> Self {
        let msg = message.into();
        let delivery_rejection = matches!(code, -204..=-200) || msg.contains("Tham số không hợp lệ");
        Self::ApiRejected {
            code,
            status,
            message: msg,
            delivery_rejection,
        }
    }

    pub fn is_rate_limited(&self) -> bool {
        matches!(
            self,
            Self::HttpTransport {
                status: Some(429),
                ..
            } | Self::ApiRejected { code: 429, .. }
                | Self::ApiRejected {
                    status: Some(429),
                    ..
                }
        )
    }

    pub fn is_delivery_rejection(&self) -> bool {
        match self {
            Self::ApiRejected {
                delivery_rejection, ..
            } => *delivery_rejection,
            _ => false,
        }
    }

    pub fn is_retryable(&self) -> bool {
        match self {
            Self::HttpTransport { retryable, .. } => *retryable,
            Self::ApiRejected {
                status: Some(s), ..
            } => is_retryable_http_status(*s),
            _ => false,
        }
    }

    pub fn status_code(&self) -> Option<u16> {
        match self {
            Self::HttpTransport { status, .. } | Self::ApiRejected { status, .. } => *status,
            _ => None,
        }
    }
}

#[inline]
pub fn is_retryable_http_status(status: u16) -> bool {
    status == 408 || status == 429 || (500..600).contains(&status)
}

/// Strips query strings and credentials before logging any Zalo URL (`uploadAttachment.js::redactEndpoint`).
pub fn redact_endpoint(raw_url: &str) -> String {
    if let Ok(mut parsed) = Url::parse(raw_url) {
        parsed.set_query(None);
        let _ = parsed.set_username("");
        let _ = parsed.set_password(None);
        parsed.to_string()
    } else {
        raw_url.split('?').next().unwrap_or("<invalid-url>").to_string()
    }
}

#[derive(Debug, Error)]
pub enum ZaloCryptoError {
    #[error("Unsupported AES key byte length: {0} (expected 16, 24, or 32)")]
    UnsupportedKeySize(usize),

    #[error("AES-CBC padding or block decryption failed")]
    CbcDecryptFailed,

    #[error("WebSocket AES-GCM frame too short: {0} bytes (minimum 48)")]
    FrameTooShort(usize),

    #[error("WebSocket AES-GCM authentication tag verification failed")]
    GcmAuthFailed,

    #[error("Base64 decode error: {0}")]
    Base64(#[from] base64::DecodeError),

    #[error("URL decode error: {0}")]
    UrlDecode(#[from] std::string::FromUtf8Error),

    #[error("Zlib/Deflate decompression error: {0}")]
    Decompress(String),

    #[error("Invalid ParamsEncryptor inputs")]
    InvalidParamsEncryptor,
}
