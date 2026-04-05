//! Standalone binary that prints the OpenAPI spec as JSON to stdout.
//! Invoked by `generate-api.sh` to produce the spec at build time
//! without needing a running server or database.

use omniviv_api::ApiDoc;
use utoipa::OpenApi;

fn main() {
    let spec = ApiDoc::openapi();
    println!(
        "{}",
        spec.to_pretty_json()
            .expect("Failed to serialize OpenAPI spec")
    );
}
