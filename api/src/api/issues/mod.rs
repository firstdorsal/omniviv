use axum::{extract::State, routing::get, Json, Router};
use serde::Serialize;
use utoipa::ToSchema;

use crate::sync::{OsmIssue, OsmIssueStore};

#[derive(Debug, Serialize, ToSchema)]
pub struct IssueListResponse {
    pub issues: Vec<OsmIssue>,
    pub count: usize,
}

/// List all OSM data quality issues
#[utoipa::path(
    get,
    path = "/api/issues",
    responses(
        (status = 200, description = "List of OSM data quality issues", body = IssueListResponse)
    ),
    tag = "issues"
)]
pub async fn list_issues(State(store): State<OsmIssueStore>) -> Json<IssueListResponse> {
    let guard = store.read().await;
    let count = guard.len();
    let issues = guard.clone();
    drop(guard);
    Json(IssueListResponse { issues, count })
}

pub fn router(issue_store: OsmIssueStore) -> Router {
    Router::new()
        .route("/", get(list_issues))
        .with_state(issue_store)
}
