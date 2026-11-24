//! `/dev/shm/mybot` RAM-backed scratchpad with `Semaphore` quota & RAII `Drop` cleanup.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

use crate::MediaError;

const BLOCK_BYTES: usize = 65_536; // 64 KiB granularity
pub const DEFAULT_SCRATCHPAD_QUOTA_BYTES: usize = 512 * 1024 * 1024; // 512 MiB

/// Manages ephemeral media buffers on Linux `tmpfs` (`/dev/shm/mybot`) with zero SSD wear.
#[derive(Clone, Debug)]
pub struct RamScratchpad {
    root: PathBuf,
    quota_bytes: usize,
    permits: Arc<Semaphore>,
}

/// RAII handle to an ephemeral scratch file. Automatically unlinks the file and returns
/// RAM quota permits as soon as it is dropped (even on panic or cancelled `tokio` task).
#[derive(Debug)]
pub struct ScratchFile {
    path: PathBuf,
    reserved_bytes: usize,
    _permit: OwnedSemaphorePermit,
}

impl ScratchFile {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn reserved_bytes(&self) -> usize {
        self.reserved_bytes
    }

    pub fn read_bytes(&self) -> Result<Vec<u8>, MediaError> {
        Ok(fs::read(&self.path)?)
    }
}

impl Drop for ScratchFile {
    fn drop(&mut self) {
        if self.path.exists() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl Default for RamScratchpad {
    fn default() -> Self {
        Self::new_default().unwrap_or_else(|_| {
            Self::new_with_quota(
                std::env::temp_dir().join("mybot-ram"),
                DEFAULT_SCRATCHPAD_QUOTA_BYTES,
            )
            .expect("fallback temp scratchpad")
        })
    }
}

impl RamScratchpad {
    /// Automatically selects `/dev/shm/mybot` on Linux Ubuntu when available, falling back
    /// to the OS temp directory otherwise.
    pub fn new_default() -> Result<Self, MediaError> {
        let root = Self::detect_preferred_root();
        Self::new_with_quota(root, DEFAULT_SCRATCHPAD_QUOTA_BYTES)
    }

    pub fn detect_preferred_root() -> PathBuf {
        #[cfg(target_os = "linux")]
        {
            let shm = Path::new("/dev/shm");
            if shm.is_dir() {
                return shm.join("mybot");
            }
        }
        std::env::temp_dir().join("mybot-ram")
    }

    pub fn new_with_quota(root: impl Into<PathBuf>, quota_bytes: usize) -> Result<Self, MediaError> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        let total_blocks = (quota_bytes.max(BLOCK_BYTES)).div_ceil(BLOCK_BYTES);
        let pad = Self {
            root,
            quota_bytes: total_blocks * BLOCK_BYTES,
            permits: Arc::new(Semaphore::new(total_blocks)),
        };
        let _ = pad.purge_stale_files();
        Ok(pad)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn quota_bytes(&self) -> usize {
        self.quota_bytes
    }

    pub fn available_bytes(&self) -> usize {
        self.permits.available_permits() * BLOCK_BYTES
    }

    pub fn is_linux_tmpfs(&self) -> bool {
        self.root.starts_with("/dev/shm")
    }

    /// Removes any orphan files left over from a hard SIGKILL crash.
    pub fn purge_stale_files(&self) -> Result<usize, MediaError> {
        let mut removed = 0usize;
        if !self.root.exists() {
            return Ok(0);
        }
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_file() && fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }

    /// Reserves `estimated_bytes` from the scratchpad quota and returns a fresh file path.
    pub async fn allocate_file(
        &self,
        prefix: &str,
        extension: &str,
        estimated_bytes: usize,
    ) -> Result<ScratchFile, MediaError> {
        let blocks = estimated_bytes.max(1).div_ceil(BLOCK_BYTES);
        let blocks_u32 = u32::try_from(blocks).map_err(|_| {
            MediaError::QuotaExceeded(format!("requested {estimated_bytes} bytes exceeds u32 blocks"))
        })?;
        if blocks * BLOCK_BYTES > self.quota_bytes {
            return Err(MediaError::QuotaExceeded(format!(
                "requested {estimated_bytes} bytes exceeds total scratchpad quota {}",
                self.quota_bytes
            )));
        }

        let permit = Arc::clone(&self.permits)
            .acquire_many_owned(blocks_u32)
            .await
            .map_err(|_| MediaError::QuotaExceeded("scratchpad semaphore closed".into()))?;

        let clean_ext = extension.trim_start_matches('.');
        let safe_prefix: String = prefix
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .take(24)
            .collect();
        let file_name = if clean_ext.is_empty() {
            format!("{}_{}", safe_prefix, Uuid::new_v4().simple())
        } else {
            format!("{}_{}.{}", safe_prefix, Uuid::new_v4().simple(), clean_ext)
        };
        let path = self.root.join(file_name);

        Ok(ScratchFile {
            path,
            reserved_bytes: blocks * BLOCK_BYTES,
            _permit: permit,
        })
    }

    /// Allocates and immediately writes `bytes` to a RAM scratch file.
    pub async fn write_temp_bytes(
        &self,
        prefix: &str,
        extension: &str,
        bytes: &[u8],
    ) -> Result<ScratchFile, MediaError> {
        let scratch = self.allocate_file(prefix, extension, bytes.len()).await?;
        tokio::fs::write(&scratch.path, bytes).await?;
        Ok(scratch)
    }
}
