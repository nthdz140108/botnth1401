//! 4-Lane Outbound Transport Rate Limiter (`src/api-zalo/transport-limiter.js` parity).
//!
//! Isolates `fast-text`, `control`, `heavy`, and `broadcast` Zalo API traffic per bot session
//! with bounded concurrency, minimum inter-dispatch spacing, and adaptive HTTP 429 cooldowns.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use mybot_types::ExecutionLane;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Semaphore};

use crate::error::ZaloApiError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct LaneConfig {
    pub max_concurrent: usize,
    pub min_gap_ms: u64,
    pub high_water: usize,
}

impl LaneConfig {
    pub fn default_for(lane: ExecutionLane) -> Self {
        match lane {
            ExecutionLane::FastText => Self {
                max_concurrent: 8,
                min_gap_ms: 0,
                high_water: 500,
            },
            ExecutionLane::Control => Self {
                max_concurrent: 8,
                min_gap_ms: 0,
                high_water: 500,
            },
            ExecutionLane::Heavy => Self {
                max_concurrent: 2,
                min_gap_ms: 50,
                high_water: 100,
            },
            ExecutionLane::Broadcast => Self {
                max_concurrent: 3,
                min_gap_ms: 50,
                high_water: 200,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneTelemetry {
    pub lane: String,
    pub max_concurrent: usize,
    pub min_time: u64,
    pub adaptive_backoff_ms: u64,
    pub queued: usize,
    pub running: usize,
    pub rejected_count: u64,
}

pub struct SingleLaneLimiter {
    lane: ExecutionLane,
    cfg: LaneConfig,
    semaphore: Arc<Semaphore>,
    spacing_gate: Mutex<u64>,
    backoff_until_ms: AtomicU64,
    adaptive_backoff_ms: AtomicU64,
    queued: AtomicUsize,
    running: AtomicUsize,
    rejected_count: AtomicU64,
}

impl SingleLaneLimiter {
    pub fn new(lane: ExecutionLane, cfg: LaneConfig) -> Self {
        let permits = cfg.max_concurrent.max(1);
        Self {
            lane,
            cfg: LaneConfig {
                max_concurrent: permits,
                ..cfg
            },
            semaphore: Arc::new(Semaphore::new(permits)),
            spacing_gate: Mutex::new(0),
            backoff_until_ms: AtomicU64::new(0),
            adaptive_backoff_ms: AtomicU64::new(0),
            queued: AtomicUsize::new(0),
            running: AtomicUsize::new(0),
            rejected_count: AtomicU64::new(0),
        }
    }

    /// Triggers lane-wide adaptive backoff (`500ms..=30_000ms`) upon HTTP/API `429`.
    pub fn notify_rate_limit(&self, retry_after_ms: u64) {
        let clamped = retry_after_ms.clamp(500, 30_000);
        let until = epoch_ms().saturating_add(clamped);
        self.adaptive_backoff_ms.store(clamped, Ordering::Relaxed);
        self.backoff_until_ms.fetch_max(until, Ordering::Relaxed);
    }

    pub async fn run<F, Fut, T>(&self, f: F) -> Result<T, ZaloApiError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, ZaloApiError>>,
    {
        self.queued.fetch_add(1, Ordering::Relaxed);
        let permit = self.semaphore.acquire().await.expect("lane semaphore open");
        self.queued.fetch_sub(1, Ordering::Relaxed);
        self.running.fetch_add(1, Ordering::Relaxed);

        // 1. Respect active 429 cooldown
        let now = epoch_ms();
        let until = self.backoff_until_ms.load(Ordering::Relaxed);
        if until > now {
            tokio::time::sleep(Duration::from_millis(until - now)).await;
        } else if self.adaptive_backoff_ms.load(Ordering::Relaxed) != 0 {
            self.adaptive_backoff_ms.store(0, Ordering::Relaxed);
        }

        // 2. Respect minimum inter-dispatch spacing (`min_gap_ms`)
        if self.cfg.min_gap_ms > 0 {
            let mut last_guard = self.spacing_gate.lock().await;
            let current = epoch_ms();
            let elapsed = current.saturating_sub(*last_guard);
            if elapsed < self.cfg.min_gap_ms {
                let wait = self.cfg.min_gap_ms - elapsed;
                tokio::time::sleep(Duration::from_millis(wait)).await;
            }
            *last_guard = epoch_ms();
        }

        let res = f().await;
        self.running.fetch_sub(1, Ordering::Relaxed);
        drop(permit);

        if let Err(ref err) = res {
            if err.is_rate_limited() {
                let prev = self.adaptive_backoff_ms.load(Ordering::Relaxed);
                let next = if prev == 0 { 2_000 } else { (prev * 2).min(30_000) };
                self.notify_rate_limit(next);
            }
            if err.is_delivery_rejection() {
                self.rejected_count.fetch_add(1, Ordering::Relaxed);
            }
        }
        res
    }

    pub fn stats(&self) -> LaneTelemetry {
        let now = epoch_ms();
        let until = self.backoff_until_ms.load(Ordering::Relaxed);
        let backoff = if until > now {
            self.adaptive_backoff_ms.load(Ordering::Relaxed)
        } else {
            0
        };
        LaneTelemetry {
            lane: self.lane.as_str().to_string(),
            max_concurrent: self.cfg.max_concurrent,
            min_time: self.cfg.min_gap_ms,
            adaptive_backoff_ms: backoff,
            queued: self.queued.load(Ordering::Relaxed),
            running: self.running.load(Ordering::Relaxed),
            rejected_count: self.rejected_count.load(Ordering::Relaxed),
        }
    }
}

/// Complete 4-lane outbound limiter owned per `ZaloSession`.
pub struct TransportLimiter {
    fast_text: SingleLaneLimiter,
    control: SingleLaneLimiter,
    heavy: SingleLaneLimiter,
    broadcast: SingleLaneLimiter,
}

impl Default for TransportLimiter {
    fn default() -> Self {
        Self::new(
            LaneConfig::default_for(ExecutionLane::FastText),
            LaneConfig::default_for(ExecutionLane::Control),
            LaneConfig::default_for(ExecutionLane::Heavy),
            LaneConfig::default_for(ExecutionLane::Broadcast),
        )
    }
}

impl TransportLimiter {
    pub fn new(
        fast_text: LaneConfig,
        control: LaneConfig,
        heavy: LaneConfig,
        broadcast: LaneConfig,
    ) -> Self {
        Self {
            fast_text: SingleLaneLimiter::new(ExecutionLane::FastText, fast_text),
            control: SingleLaneLimiter::new(ExecutionLane::Control, control),
            heavy: SingleLaneLimiter::new(ExecutionLane::Heavy, heavy),
            broadcast: SingleLaneLimiter::new(ExecutionLane::Broadcast, broadcast),
        }
    }

    #[inline]
    pub fn lane(&self, kind: ExecutionLane) -> &SingleLaneLimiter {
        match kind {
            ExecutionLane::FastText => &self.fast_text,
            ExecutionLane::Control => &self.control,
            ExecutionLane::Heavy => &self.heavy,
            ExecutionLane::Broadcast => &self.broadcast,
        }
    }

    pub async fn execute<F, Fut, T>(&self, kind: ExecutionLane, f: F) -> Result<T, ZaloApiError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, ZaloApiError>>,
    {
        self.lane(kind).run(f).await
    }

    pub fn snapshot(&self) -> [LaneTelemetry; 4] {
        [
            self.fast_text.stats(),
            self.control.stats(),
            self.heavy.stats(),
            self.broadcast.stats(),
        ]
    }
}

#[inline]
fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn limiter_tracks_429_backoff_and_delivery_rejection() {
        let limiter = TransportLimiter::default();
        let err = limiter
            .execute(ExecutionLane::FastText, || async {
                Err::<(), _>(ZaloApiError::api_rejected(-201, Some(200), "blocked"))
            })
            .await
            .unwrap_err();
        assert!(err.is_delivery_rejection());
        assert_eq!(limiter.lane(ExecutionLane::FastText).stats().rejected_count, 1);

        let _ = limiter
            .execute(ExecutionLane::Heavy, || async {
                Err::<(), _>(ZaloApiError::HttpTransport {
                    endpoint: "https://file.chat.zalo.me/api".into(),
                    status: Some(429),
                    retryable: true,
                    message: "Too Many Requests".into(),
                })
            })
            .await;
        assert!(limiter.lane(ExecutionLane::Heavy).stats().adaptive_backoff_ms >= 2_000);
    }
}
