use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;

use sqlx::PgPool;
use tokio::sync::Mutex;

use super::schedule_cache::ScheduleCache;
use crate::sync::{DepartureStore, VehicleUpdateSender};

/// Tracks active WebSocket connections per IP to prevent resource exhaustion.
#[derive(Clone, Default)]
pub struct WsConnectionTracker {
    counts: Arc<Mutex<HashMap<IpAddr, u32>>>,
}

/// Maximum concurrent WebSocket connections per IP address.
/// Behind a reverse proxy all clients share one upstream IP,
/// so this must be generous enough for multiple browser tabs.
const MAX_WS_PER_IP: u32 = 50;

impl WsConnectionTracker {
    /// Try to register a new connection. Returns `Ok(guard)` if under the limit,
    /// `Err(count)` with the current count if the limit is exceeded.
    pub async fn try_connect(&self, ip: IpAddr) -> Result<WsConnectionGuard, u32> {
        let mut counts = self.counts.lock().await;
        let count = counts.entry(ip).or_insert(0);
        if *count >= MAX_WS_PER_IP {
            return Err(*count);
        }
        *count += 1;
        Ok(WsConnectionGuard {
            tracker: self.clone(),
            ip,
        })
    }
}

/// RAII guard that decrements the connection count on drop.
pub struct WsConnectionGuard {
    tracker: WsConnectionTracker,
    ip: IpAddr,
}

impl Drop for WsConnectionGuard {
    fn drop(&mut self) {
        let tracker = self.tracker.clone();
        let ip = self.ip;
        // Use spawn_blocking-style approach — but since we need async, use try_lock
        // and fall back to a spawned task if contended.
        if let Ok(mut counts) = self.tracker.counts.try_lock() {
            if let Some(count) = counts.get_mut(&ip) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    counts.remove(&ip);
                }
            }
        } else {
            tokio::spawn(async move {
                let mut counts = tracker.counts.lock().await;
                if let Some(count) = counts.get_mut(&ip) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        counts.remove(&ip);
                    }
                }
            });
        }
    }
}

/// Shared application state for handlers that need departure/vehicle data.
///
/// Used by the vehicles, departures, and WebSocket handlers. Handlers that
/// only need the database pool (areas, routes, stations, etc.) continue to
/// receive `PgPool` directly.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub departure_store: DepartureStore,
    pub time_horizon_minutes: u32,
    pub timezone: chrono_tz::Tz,
    pub vehicle_updates_tx: VehicleUpdateSender,
    pub schedule_cache: ScheduleCache,
    pub ws_tracker: WsConnectionTracker,
}
