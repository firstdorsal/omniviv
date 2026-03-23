use std::collections::{HashMap, HashSet};
use std::path::Path;

use chrono::NaiveDate;
use sqlx::PgPool;
use tracing::{debug, info, warn};

use super::super::error::GtfsError;
use super::csv::{parse_calendar, parse_calendar_dates, parse_gtfs_time, parse_routes, parse_stops, parse_trips};
use super::download::MAX_DECOMPRESSED_SIZE;
use super::types::{
    GtfsCalendar, GtfsCalendarDate, GtfsRoute, GtfsSchedule, GtfsStop, GtfsStopTime, GtfsTrip,
};

/// Maximum rows per batch for bulk INSERT into PostgreSQL.
/// PostgreSQL supports max 65535 bind parameters per query.
/// With 5 columns per row: 65535 / 5 = 13107 max.
const DB_BATCH_SIZE: usize = 10_000;
/// Calendar has 10 columns: 65535 / 10 = 6553 max.
const DB_BATCH_SIZE_CALENDAR: usize = 5_000;

/// A single stop_time row for streaming insertion (avoids holding all 31.5M rows in memory).
struct StopTimeRow {
    trip_id: String,
    stop_sequence: i32,
    stop_id: String,
    arrival_time: Option<i32>,
    departure_time: Option<i32>,
}

/// Load GTFS data from a zip file into PostgreSQL tables.
///
/// Parses CSV files from the zip, truncates existing GTFS data,
/// and bulk-inserts all records into the database. Stop times (the largest
/// table at ~31.5M rows) are streamed via a channel to avoid holding them
/// all in memory at once.
pub async fn load_schedule_to_db(pool: &PgPool, zip_path: &Path) -> Result<(), GtfsError> {
    info!("Parsing GTFS zip for database loading...");

    // Phase 1: Parse everything except stop_times (all fit in memory)
    let path = zip_path.to_path_buf();
    let (stops, routes, trips, calendars, calendar_dates) =
        tokio::task::spawn_blocking({
            let path = path.clone();
            move || -> Result<_, GtfsError> {
                let file = std::fs::File::open(&path)?;
                let mut archive = zip::ZipArchive::new(file)?;

                // ZIP bomb protection
                let mut total_uncompressed: u64 = 0;
                for i in 0..archive.len() {
                    if let Ok(entry) = archive.by_index(i) {
                        total_uncompressed += entry.size();
                    }
                }
                if total_uncompressed > MAX_DECOMPRESSED_SIZE {
                    return Err(GtfsError::ParseError(format!(
                        "GTFS zip decompressed size {} bytes exceeds limit {} bytes",
                        total_uncompressed, MAX_DECOMPRESSED_SIZE
                    )));
                }

                let stops = parse_stops(&mut archive)?;
                let routes = parse_routes(&mut archive)?;
                let trips = parse_trips(&mut archive)?;
                let calendars = parse_calendar(&mut archive);
                let calendar_dates = parse_calendar_dates(&mut archive);

                Ok((stops, routes, trips, calendars, calendar_dates))
            }
        })
        .await??;

    let stop_count = stops.len();
    let route_count = routes.len();
    let trip_count = trips.len();

    info!(
        stops = stop_count,
        routes = route_count,
        trips = trip_count,
        "Parsed GTFS data (except stop_times), loading into database..."
    );

    // Truncate all GTFS tables (fast, DDL-level reset)
    sqlx::query(
        "TRUNCATE gtfs_stop_times, gtfs_trips, gtfs_routes, gtfs_stops, \
         gtfs_calendar, gtfs_calendar_dates, ifopt_gtfs_mapping, gtfs_feed_meta",
    )
    .execute(pool)
    .await?;
    info!("Truncated existing GTFS tables");

    // --- Insert stops ---
    let stop_values: Vec<_> = stops.values().collect();
    for (batch_idx, batch) in stop_values.chunks(DB_BATCH_SIZE).enumerate() {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO gtfs_stops (stop_id, stop_name, parent_station, lat, lon) ",
        );
        qb.push_values(batch.iter(), |mut b, stop| {
            b.push_bind(&stop.stop_id)
                .push_bind(&stop.stop_name)
                .push_bind(&stop.parent_station)
                .push_bind(stop.lat)
                .push_bind(stop.lon);
        });
        qb.build().execute(pool).await?;
        if (batch_idx + 1) % 10 == 0 {
            debug!(batch = batch_idx + 1, "Inserted stops batch");
        }
    }
    info!(count = stop_count, "Inserted GTFS stops");

    // --- Insert routes ---
    let route_values: Vec<_> = routes.values().collect();
    for batch in route_values.chunks(DB_BATCH_SIZE) {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO gtfs_routes (route_id, route_short_name, route_long_name, route_type) ",
        );
        qb.push_values(batch.iter(), |mut b, route| {
            b.push_bind(&route.route_id)
                .push_bind(&route.route_short_name)
                .push_bind(&route.route_long_name)
                .push_bind(route.route_type);
        });
        qb.build().execute(pool).await?;
    }
    info!(count = route_count, "Inserted GTFS routes");

    // --- Insert trips ---
    let trip_values: Vec<_> = trips.values().collect();
    for batch in trip_values.chunks(DB_BATCH_SIZE) {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO gtfs_trips (trip_id, route_id, service_id, trip_headsign, direction_id) ",
        );
        qb.push_values(batch.iter(), |mut b, trip| {
            b.push_bind(&trip.trip_id)
                .push_bind(&trip.route_id)
                .push_bind(&trip.service_id)
                .push_bind(&trip.trip_headsign)
                .push_bind(trip.direction_id);
        });
        qb.build().execute(pool).await?;
    }
    info!(count = trip_count, "Inserted GTFS trips");

    // --- Stream stop_times (largest table: ~31.5M rows) ---
    // Instead of loading all rows into memory (which would use ~2.5GB),
    // we stream batches through a channel from a blocking CSV reader.
    let (tx, mut rx) =
        tokio::sync::mpsc::channel::<Result<Vec<StopTimeRow>, GtfsError>>(4);

    let producer = tokio::task::spawn_blocking(move || -> Result<usize, GtfsError> {
        let file = std::fs::File::open(&path)?;
        let mut archive = zip::ZipArchive::new(file)?;

        info!("Parsing stop_times.txt (streaming)");
        let csv_file = archive.by_name("stop_times.txt")?;
        let mut rdr = csv::Reader::from_reader(csv_file);
        let headers = rdr.headers()?.clone();

        let idx_trip = headers
            .iter()
            .position(|h| h == "trip_id")
            .ok_or_else(|| GtfsError::ParseError("stop_times.txt missing trip_id".into()))?;
        let idx_seq = headers
            .iter()
            .position(|h| h == "stop_sequence")
            .ok_or_else(|| {
                GtfsError::ParseError("stop_times.txt missing stop_sequence".into())
            })?;
        let idx_stop = headers
            .iter()
            .position(|h| h == "stop_id")
            .ok_or_else(|| GtfsError::ParseError("stop_times.txt missing stop_id".into()))?;
        let idx_arr = headers.iter().position(|h| h == "arrival_time");
        let idx_dep = headers.iter().position(|h| h == "departure_time");

        let mut batch = Vec::with_capacity(DB_BATCH_SIZE);
        let mut total_rows = 0usize;
        let mut skipped = 0usize;

        for result in rdr.records() {
            let record = result?;
            let trip_id = record.get(idx_trip).unwrap_or("").to_string();
            if trip_id.is_empty() {
                skipped += 1;
                continue;
            }
            batch.push(StopTimeRow {
                trip_id,
                stop_sequence: record
                    .get(idx_seq)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
                stop_id: record.get(idx_stop).unwrap_or("").to_string(),
                arrival_time: idx_arr
                    .and_then(|i| record.get(i))
                    .and_then(parse_gtfs_time),
                departure_time: idx_dep
                    .and_then(|i| record.get(i))
                    .and_then(parse_gtfs_time),
            });
            total_rows += 1;

            if batch.len() >= DB_BATCH_SIZE {
                if tx.blocking_send(Ok(std::mem::take(&mut batch))).is_err() {
                    return Err(GtfsError::ParseError(
                        "stop_times receiver dropped".into(),
                    ));
                }
                batch = Vec::with_capacity(DB_BATCH_SIZE);
            }
        }

        // Send remaining rows
        if !batch.is_empty() {
            let _ = tx.blocking_send(Ok(batch));
        }

        if skipped > 0 {
            warn!(skipped, "Skipped stop_times.txt records with empty trip_id");
        }

        Ok(total_rows)
    });

    // Receive and insert batches as they arrive
    let mut stop_time_count = 0usize;
    let mut batch_idx = 0usize;
    while let Some(batch_result) = rx.recv().await {
        let batch = batch_result?;
        stop_time_count += batch.len();
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO gtfs_stop_times (trip_id, stop_sequence, stop_id, arrival_time, departure_time) ",
        );
        qb.push_values(batch.iter(), |mut b, st| {
            b.push_bind(&st.trip_id)
                .push_bind(st.stop_sequence)
                .push_bind(&st.stop_id)
                .push_bind(st.arrival_time)
                .push_bind(st.departure_time);
        });
        qb.build().execute(pool).await?;
        batch_idx += 1;
        if batch_idx % 100 == 0 {
            info!(
                batch = batch_idx,
                rows = stop_time_count,
                "Inserting stop_times..."
            );
        }
    }

    // Wait for the producer to finish and check for errors
    let producer_count = producer.await??;
    debug_assert_eq!(stop_time_count, producer_count);
    info!(count = stop_time_count, "Inserted GTFS stop_times");

    // --- Insert calendar ---
    let cal_values: Vec<_> = calendars.values().collect();
    for batch in cal_values.chunks(DB_BATCH_SIZE_CALENDAR) {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO gtfs_calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) ",
        );
        qb.push_values(batch.iter(), |mut b, cal| {
            b.push_bind(&cal.service_id)
                .push_bind(cal.days[0])
                .push_bind(cal.days[1])
                .push_bind(cal.days[2])
                .push_bind(cal.days[3])
                .push_bind(cal.days[4])
                .push_bind(cal.days[5])
                .push_bind(cal.days[6])
                .push_bind(cal.start_date)
                .push_bind(cal.end_date);
        });
        qb.build().execute(pool).await?;
    }
    info!(count = calendars.len(), "Inserted GTFS calendar");

    // --- Insert calendar_dates ---
    let flat_cal_dates: Vec<(&String, &GtfsCalendarDate)> = calendar_dates
        .iter()
        .flat_map(|(service_id, dates)| dates.iter().map(move |d| (service_id, d)))
        .collect();
    for batch in flat_cal_dates.chunks(DB_BATCH_SIZE) {
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO gtfs_calendar_dates (service_id, date, exception_type) ",
        );
        qb.push_values(batch.iter(), |mut b, (service_id, cd)| {
            b.push_bind(service_id.as_str())
                .push_bind(cd.date)
                .push_bind(cd.exception_type);
        });
        qb.build().execute(pool).await?;
    }
    info!(count = flat_cal_dates.len(), "Inserted GTFS calendar_dates");

    // --- Update feed metadata ---
    sqlx::query(
        "INSERT INTO gtfs_feed_meta (id, loaded_at, stop_count, route_count, trip_count, stop_time_count) \
         VALUES (1, now(), $1, $2, $3, $4) \
         ON CONFLICT (id) DO UPDATE SET \
         loaded_at = now(), stop_count = $1, route_count = $2, trip_count = $3, stop_time_count = $4",
    )
    .bind(stop_count as i64)
    .bind(route_count as i64)
    .bind(trip_count as i64)
    .bind(stop_time_count as i64)
    .execute(pool)
    .await?;

    info!(
        stops = stop_count,
        routes = route_count,
        trips = trip_count,
        stop_times = stop_time_count,
        "GTFS data loaded into database"
    );
    Ok(())
}

/// Build a partial GtfsSchedule from PostgreSQL containing only data relevant
/// to the given IFOPT stop IDs. Used by the realtime processing cycle to avoid
/// holding the full schedule (~1GB) in memory.
///
/// Executes 7 batch queries to load:
/// 1. IFOPT <-> GTFS mapping for the given stops
/// 2. Trip IDs visiting those stops
/// 3. Trip details, stop_times, routes, calendars, stop names
pub async fn build_schedule_from_db(
    pool: &PgPool,
    relevant_ifopt_ids: &HashSet<String>,
) -> Result<GtfsSchedule, GtfsError> {
    let ifopt_list: Vec<&str> = relevant_ifopt_ids.iter().map(|s| s.as_str()).collect();

    // Get IFOPT -> GTFS mapping for our monitored stops
    let mapping_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT ifopt, gtfs_stop_id FROM ifopt_gtfs_mapping \
         WHERE ifopt = ANY($1::text[]) \
         ORDER BY is_manual DESC, combined_score DESC",
    )
    .bind(&ifopt_list)
    .fetch_all(pool)
    .await?;

    let mut ifopt_to_gtfs: HashMap<String, Vec<String>> = HashMap::new();
    let mut gtfs_to_ifopt: HashMap<String, Vec<String>> = HashMap::new();
    for (ifopt, gtfs_id) in &mapping_rows {
        ifopt_to_gtfs
            .entry(ifopt.clone())
            .or_default()
            .push(gtfs_id.clone());
        gtfs_to_ifopt
            .entry(gtfs_id.clone())
            .or_default()
            .push(ifopt.clone());
    }

    let gtfs_stop_ids: Vec<String> = gtfs_to_ifopt.keys().cloned().collect();
    if gtfs_stop_ids.is_empty() {
        debug!("No GTFS mapping found for relevant stops, returning empty schedule");
        return Ok(GtfsSchedule::empty_with_mappings(ifopt_to_gtfs, gtfs_to_ifopt));
    }

    let gtfs_id_refs: Vec<&str> = gtfs_stop_ids.iter().map(|s| s.as_str()).collect();
    build_schedule_from_gtfs_ids(pool, &gtfs_id_refs, ifopt_to_gtfs, gtfs_to_ifopt).await
}

/// Build a GTFS schedule from the database using GTFS stop IDs directly,
/// bypassing the IFOPT mapping. Used for querying departures at GTFS stops
/// that may not have an IFOPT mapping.
pub async fn build_schedule_from_db_by_gtfs_stop(
    pool: &PgPool,
    gtfs_stop_ids: &HashSet<String>,
) -> Result<GtfsSchedule, GtfsError> {
    let gtfs_id_list: Vec<&str> = gtfs_stop_ids.iter().map(|s| s.as_str()).collect();
    if gtfs_id_list.is_empty() {
        return Ok(GtfsSchedule::empty_with_mappings(HashMap::new(), HashMap::new()));
    }
    build_schedule_from_gtfs_ids(pool, &gtfs_id_list, HashMap::new(), HashMap::new()).await
}

/// Shared implementation: load trips, stop_times, routes, calendars, and stops
/// for the given GTFS stop IDs and assemble a GtfsSchedule.
async fn build_schedule_from_gtfs_ids(
    pool: &PgPool,
    gtfs_stop_ids: &[&str],
    ifopt_to_gtfs: HashMap<String, Vec<String>>,
    gtfs_to_ifopt: HashMap<String, Vec<String>>,
) -> Result<GtfsSchedule, GtfsError> {
    // 1. Get trip IDs that visit our GTFS stops
    let trip_ids: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT trip_id FROM gtfs_stop_times WHERE stop_id = ANY($1::text[])",
    )
    .bind(gtfs_stop_ids)
    .fetch_all(pool)
    .await?;

    info!(
        gtfs_stops = gtfs_stop_ids.len(),
        relevant_trips = trip_ids.len(),
        "Found trips visiting monitored stops"
    );

    if trip_ids.is_empty() {
        return Ok(GtfsSchedule::empty_with_mappings(ifopt_to_gtfs, gtfs_to_ifopt));
    }

    // 2. Load trip details
    let trip_rows: Vec<(String, String, String, Option<String>, Option<i32>)> = sqlx::query_as(
        "SELECT trip_id, route_id, service_id, trip_headsign, direction_id \
         FROM gtfs_trips WHERE trip_id = ANY($1::text[])",
    )
    .bind(&trip_ids)
    .fetch_all(pool)
    .await?;

    let mut trips = HashMap::with_capacity(trip_rows.len());
    let mut route_ids: HashSet<String> = HashSet::new();
    let mut service_ids: HashSet<String> = HashSet::new();
    for (trip_id, route_id, service_id, headsign, direction_id) in trip_rows {
        route_ids.insert(route_id.clone());
        service_ids.insert(service_id.clone());
        trips.insert(
            trip_id.clone(),
            GtfsTrip {
                trip_id,
                route_id,
                service_id,
                trip_headsign: headsign,
                direction_id,
            },
        );
    }

    // 3. Load stop_times
    let stop_time_rows: Vec<(String, i32, String, Option<i32>, Option<i32>)> = sqlx::query_as(
        "SELECT trip_id, stop_sequence, stop_id, arrival_time, departure_time \
         FROM gtfs_stop_times WHERE trip_id = ANY($1::text[]) \
         ORDER BY trip_id, stop_sequence",
    )
    .bind(&trip_ids)
    .fetch_all(pool)
    .await?;

    let mut stop_times: HashMap<String, Vec<GtfsStopTime>> = HashMap::new();
    let mut all_stop_ids: HashSet<String> = HashSet::new();
    for (trip_id, seq, stop_id, arrival, departure) in stop_time_rows {
        all_stop_ids.insert(stop_id.clone());
        stop_times
            .entry(trip_id)
            .or_default()
            .push(GtfsStopTime {
                stop_sequence: seq,
                stop_id,
                arrival_time: arrival,
                departure_time: departure,
            });
    }

    // Build trips_by_stop reverse index
    let mut trips_by_stop: HashMap<String, HashSet<String>> = HashMap::new();
    for (trip_id, stop_time_list) in &stop_times {
        for stop_time in stop_time_list {
            trips_by_stop
                .entry(stop_time.stop_id.clone())
                .or_default()
                .insert(trip_id.clone());
        }
    }

    // 4. Load routes
    let route_id_list: Vec<String> = route_ids.into_iter().collect();
    let route_rows: Vec<(String, Option<String>, Option<String>, Option<i32>)> = sqlx::query_as(
        "SELECT route_id, route_short_name, route_long_name, route_type \
         FROM gtfs_routes WHERE route_id = ANY($1::text[])",
    )
    .bind(&route_id_list)
    .fetch_all(pool)
    .await?;

    let mut routes = HashMap::with_capacity(route_rows.len());
    for (route_id, short, long, rtype) in route_rows {
        routes.insert(
            route_id.clone(),
            GtfsRoute {
                route_id,
                route_short_name: short,
                route_long_name: long,
                route_type: rtype,
            },
        );
    }

    // 5. Load calendars and calendar_dates
    let service_id_list: Vec<String> = service_ids.into_iter().collect();
    let cal_rows: Vec<(
        String, bool, bool, bool, bool, bool, bool, bool, NaiveDate, NaiveDate,
    )> = sqlx::query_as(
        "SELECT service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, \
         start_date, end_date FROM gtfs_calendar WHERE service_id = ANY($1::text[])",
    )
    .bind(&service_id_list)
    .fetch_all(pool)
    .await?;

    let mut calendars = HashMap::with_capacity(cal_rows.len());
    for (sid, mon, tue, wed, thu, fri, sat, sun, start, end_d) in cal_rows {
        calendars.insert(
            sid.clone(),
            GtfsCalendar {
                service_id: sid,
                days: [mon, tue, wed, thu, fri, sat, sun],
                start_date: start,
                end_date: end_d,
            },
        );
    }

    let cd_rows: Vec<(String, NaiveDate, i32)> = sqlx::query_as(
        "SELECT service_id, date, exception_type \
         FROM gtfs_calendar_dates WHERE service_id = ANY($1::text[])",
    )
    .bind(&service_id_list)
    .fetch_all(pool)
    .await?;

    let mut calendar_dates: HashMap<String, Vec<GtfsCalendarDate>> = HashMap::new();
    for (sid, date, exc_type) in cd_rows {
        calendar_dates
            .entry(sid)
            .or_default()
            .push(GtfsCalendarDate {
                date,
                exception_type: exc_type,
            });
    }

    // 6. Load stop names
    let stop_id_list: Vec<String> = all_stop_ids.into_iter().collect();
    let stop_rows: Vec<(String, Option<String>, Option<String>, Option<f64>, Option<f64>)> =
        sqlx::query_as(
            "SELECT stop_id, stop_name, parent_station, lat, lon \
             FROM gtfs_stops WHERE stop_id = ANY($1::text[])",
        )
        .bind(&stop_id_list)
        .fetch_all(pool)
        .await?;

    let mut stops = HashMap::with_capacity(stop_rows.len());
    for (stop_id, name, parent, lat, lon) in stop_rows {
        stops.insert(
            stop_id.clone(),
            GtfsStop {
                stop_id,
                stop_name: name,
                parent_station: parent,
                lat,
                lon,
            },
        );
    }

    info!(
        trips = trips.len(),
        stop_times_trips = stop_times.len(),
        routes = routes.len(),
        stops = stops.len(),
        mapping = ifopt_to_gtfs.len(),
        "Built realtime cache from PostgreSQL"
    );

    Ok(GtfsSchedule {
        stops,
        routes,
        trips,
        stop_times,
        calendars,
        calendar_dates,
        trips_by_stop,
        ifopt_to_gtfs,
        gtfs_to_ifopt,
        loaded_at: chrono::Utc::now(),
    })
}
