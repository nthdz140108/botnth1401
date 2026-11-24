# Zalo ChatBot Project — Windows Runtime High-Performance Architecture
# Node.js 20 on Windows Server 2012 / Windows 10/11

This Zalo ChatBot project is developed using Node.js 20 ESM with the **zlbotdqt** library and optimized for high-concurrency workloads (300 groups / 32 pipeline shards) on Windows Server 2012 x64 and Windows 10/11.

## Key Architecture & Features

- **Sharded Inbound Pipeline**: 32 concurrent FIFO worker shards per `threadId` with durable disk spooling under memory pressure.
- **Write-Behind Repositories**: In-memory mutations for hot data (ranks, message cache, training logs) with batched asynchronous disk persistence.
- **Worker Thread Offloading**: CPU-heavy tasks (nsfwjs image classification, Canvas rendering) execute on separate worker threads without blocking the event loop.
- **Dual-Read/Dual-Write SQLite Storage**: Transition path from JSON stores to SQLite with WAL mode and zero downtime fallback.
- **23:59 Runtime Maintenance**: Automated daily cache pruning, disk buffer flushing, and worker management.
- **Crash-Proof WebSocket Listener**: Tolerates corrupted frames, automatic reconnect with exponential backoff & jitter, outbound rate limiting.

## Deployment & Operation

Please refer to [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md) for full instructions:
- **Start Bot**: `run.bat` or `.\run.ps1`
- **Safe Update**: `.\update.ps1`
- **Health Probe**: `node scripts/windows-healthcheck.js`
- **Preflight Check**: `node scripts/preflight-sqlite.js`

## Configuration

1. **Bot Settings**: Configure runtime parameters in `assets/config.json` or `.env.local`.
2. **YouTube Authentication**: If YouTube reports `Sign in to confirm you're not a bot`, configure `YOUTUBE_COOKIES_FROM_BROWSER=chrome` in `.env.local`.
