use axum::{extract::State, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, QueryBuilder};
use utoipa::{IntoParams, ToSchema};

#[derive(Clone)]
pub struct GtfsStopsState {
    pub pool: PgPool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GtfsStopResponse {
    pub stop_id: String,
    pub stop_name: Option<String>,
    pub parent_station: Option<String>,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GtfsStopsListResponse {
    pub stops: Vec<GtfsStopResponse>,
    /// Total number of stops matching the filter criteria
    pub total_count: usize,
    /// Current offset in the result set
    pub offset: usize,
    /// Maximum number of results returned
    pub limit: usize,
    /// Whether there are more results after this page
    pub has_more: bool,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct GtfsStopsQuery {
    /// Comma-separated list of stop IDs to fetch
    pub stop_ids: Option<String>,
    /// Case-insensitive substring search on stop name
    pub search: Option<String>,
    /// Minimum latitude for bounding box filter
    pub min_lat: Option<f64>,
    /// Maximum latitude for bounding box filter
    pub max_lat: Option<f64>,
    /// Minimum longitude for bounding box filter
    pub min_lon: Option<f64>,
    /// Maximum longitude for bounding box filter
    pub max_lon: Option<f64>,
    /// Filter by parent station ID
    pub parent_station: Option<String>,
    /// Only return leaf stops (stops that have trips visiting them)
    #[serde(default = "default_leaf_only")]
    pub leaf_only: bool,
    /// Offset for pagination (default: 0)
    #[serde(default)]
    pub offset: usize,
    /// Maximum number of results to return (default: 100, max: 1000)
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    100
}

const MAX_LIMIT: usize = 1000;

fn default_leaf_only() -> bool {
    true
}

#[derive(Debug, FromRow)]
struct GtfsStopRow {
    stop_id: String,
    stop_name: Option<String>,
    parent_station: Option<String>,
    lat: Option<f64>,
    lon: Option<f64>,
}

/// List GTFS stops
///
/// Returns GTFS stops with coordinates. By default, only returns leaf stops
/// (stops that have actual departures). Use the bounding box parameters to
/// filter by geographic area.
#[utoipa::path(
    get,
    path = "/api/gtfs-stops",
    params(GtfsStopsQuery),
    responses(
        (status = 200, description = "List of GTFS stops", body = GtfsStopsListResponse)
    ),
    tag = "gtfs-stops"
)]
pub async fn list_gtfs_stops(
    State(state): State<GtfsStopsState>,
    axum::extract::Query(query): axum::extract::Query<GtfsStopsQuery>,
) -> Json<GtfsStopsListResponse> {
    // Clamp limit to MAX_LIMIT
    let limit = query.limit.min(MAX_LIMIT);
    let offset = query.offset;

    // Parse stop_ids filter if provided
    let stop_ids_filter: Option<Vec<String>> = query
        .stop_ids
        .as_ref()
        .map(|ids| ids.split(',').map(|s| s.trim().to_string()).collect());

    // Build a dynamic SQL query with filters
    let mut count_builder: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(
        "SELECT COUNT(*) FROM gtfs_stops s WHERE s.lat IS NOT NULL AND s.lon IS NOT NULL",
    );
    let mut query_builder: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(
        "SELECT s.stop_id, s.stop_name, s.parent_station, s.lat, s.lon FROM gtfs_stops s WHERE s.lat IS NOT NULL AND s.lon IS NOT NULL",
    );

    // Apply filters to both builders in parallel
    fn apply_filters(
        builder: &mut QueryBuilder<sqlx::Postgres>,
        stop_ids_filter: &Option<Vec<String>>,
        search: &Option<String>,
        min_lat: Option<f64>,
        max_lat: Option<f64>,
        min_lon: Option<f64>,
        max_lon: Option<f64>,
        parent_station: &Option<String>,
        leaf_only: bool,
        skip_leaf_for_ids: bool,
    ) {
        if let Some(ids) = stop_ids_filter {
            builder.push(" AND s.stop_id = ANY(");
            builder.push_bind(ids.clone());
            builder.push("::text[])");
        }

        if let Some(term) = search {
            builder.push(" AND s.stop_name ILIKE ");
            builder.push_bind(format!("%{}%", term));
        }

        if let Some(lat) = min_lat {
            builder.push(" AND s.lat >= ");
            builder.push_bind(lat);
        }
        if let Some(lat) = max_lat {
            builder.push(" AND s.lat <= ");
            builder.push_bind(lat);
        }
        if let Some(lon) = min_lon {
            builder.push(" AND s.lon >= ");
            builder.push_bind(lon);
        }
        if let Some(lon) = max_lon {
            builder.push(" AND s.lon <= ");
            builder.push_bind(lon);
        }

        if let Some(parent) = parent_station {
            builder.push(" AND s.parent_station = ");
            builder.push_bind(parent.clone());
        }

        // leaf_only: only return stops that have trips visiting them
        if leaf_only && !skip_leaf_for_ids {
            builder.push(
                " AND EXISTS (SELECT 1 FROM gtfs_stop_times st WHERE st.stop_id = s.stop_id)",
            );
        }
    }

    let skip_leaf = stop_ids_filter.is_some();
    apply_filters(
        &mut count_builder,
        &stop_ids_filter,
        &query.search,
        query.min_lat,
        query.max_lat,
        query.min_lon,
        query.max_lon,
        &query.parent_station,
        query.leaf_only,
        skip_leaf,
    );
    apply_filters(
        &mut query_builder,
        &stop_ids_filter,
        &query.search,
        query.min_lat,
        query.max_lat,
        query.min_lon,
        query.max_lon,
        &query.parent_station,
        query.leaf_only,
        skip_leaf,
    );

    // Add ordering and pagination to data query
    query_builder.push(" ORDER BY s.stop_name NULLS LAST, s.stop_id");
    query_builder.push(" LIMIT ");
    query_builder.push_bind(limit as i64);
    query_builder.push(" OFFSET ");
    query_builder.push_bind(offset as i64);

    // Execute count query
    let total_count: i64 = count_builder
        .build_query_scalar()
        .fetch_one(&state.pool)
        .await
        .unwrap_or(0);
    let total_count = total_count as usize;

    // Execute data query
    let rows: Vec<GtfsStopRow> = query_builder
        .build_query_as()
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();

    let stops: Vec<GtfsStopResponse> = rows
        .into_iter()
        .filter_map(|row| {
            Some(GtfsStopResponse {
                stop_id: row.stop_id,
                stop_name: row.stop_name,
                parent_station: row.parent_station,
                lat: row.lat?,
                lon: row.lon?,
            })
        })
        .collect();

    let has_more = offset + stops.len() < total_count;

    Json(GtfsStopsListResponse {
        stops,
        total_count,
        offset,
        limit,
        has_more,
    })
}

pub fn router(pool: PgPool) -> Router {
    let state = GtfsStopsState { pool };
    Router::new()
        .route("/", get(list_gtfs_stops))
        .with_state(state)
}
