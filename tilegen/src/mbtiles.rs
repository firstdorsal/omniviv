//! MBTiles file replacement that preserves the inode of the destination file.
//!
//! Background: Martin (the tile server) holds an open SQLite connection to each
//! MBTiles source. When we naïvely `rename()` a freshly-generated tmp file over
//! the existing output, the destination's inode changes. Martin's existing
//! connection still points at the old (now unlinked) inode and keeps serving
//! stale tiles forever.
//!
//! Solution: instead of renaming, we open the existing destination as a
//! SQLite database, ATTACH the tmp database, and copy `tiles`/`metadata` rows
//! across in a single transaction. This preserves the destination's inode so
//! Martin's cached connections see the new data on their next query without
//! any external restart, signal, or docker command.
//!
//! On the very first generation (when the destination doesn't exist yet),
//! we fall back to a plain rename — there's no open Martin connection to
//! worry about for a brand-new file.

use std::path::Path;

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, Executor, Row, SqliteConnection};

use crate::error::TilegenError;

/// Check whether the given mbtiles file uses the "flat" schema where
/// `tiles` is a base table that supports DELETE/INSERT directly.
/// Returns false for the "normalized" schema where `tiles` is a view.
async fn is_flat_mbtiles(path: &str) -> Result<bool, TilegenError> {
    let mut conn = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .connect()
        .await?;
    let row = sqlx::query("SELECT type FROM sqlite_master WHERE name = 'tiles'")
        .fetch_optional(&mut conn)
        .await?;
    let _ = conn.close().await;
    match row {
        Some(r) => {
            let t: String = r.try_get("type").unwrap_or_default();
            Ok(t == "table")
        }
        None => Ok(false),
    }
}

/// Replace `output` with the contents of `tmp`, preserving `output`'s inode
/// when it already exists. The tmp file is removed on success.
///
/// Returns an error if either file cannot be opened, the SQL transaction
/// fails, or the cleanup of the tmp file fails.
pub async fn replace_mbtiles_in_place(
    tmp: &Path,
    output: &Path,
) -> Result<(), TilegenError> {
    let started = std::time::Instant::now();
    if !output.exists() {
        // First-ever generation — no Martin connection to invalidate.
        std::fs::rename(tmp, output)?;
        tracing::info!(
            output = %output.display(),
            "Renamed tmp → output (first run, no in-place update needed)"
        );
        return Ok(());
    }

    let tmp_str = tmp.to_str().ok_or_else(|| {
        TilegenError::ConfigValidation(format!("tmp path is not valid UTF-8: {}", tmp.display()))
    })?;
    let output_str = output.to_str().ok_or_else(|| {
        TilegenError::ConfigValidation(format!("output path is not valid UTF-8: {}", output.display()))
    })?;

    // Check the existing destination's schema. martin-cp's default
    // "normalized" schema stores tiles as a VIEW over (images, map) which
    // sqlite refuses to UPDATE. In that case the inode-preserving in-place
    // path doesn't work — fall back to rename, which costs an inode change
    // (and thus a Martin restart on the next request) but is correct.
    if !is_flat_mbtiles(output_str).await? {
        tracing::warn!(
            output = %output.display(),
            "existing mbtiles uses normalized schema (tiles is a view); falling back to rename"
        );
        std::fs::rename(tmp, output)?;
        return Ok(());
    }

    tracing::info!(
        output = %output.display(),
        tmp = %tmp.display(),
        "Replacing mbtiles in place via SQL ATTACH+copy"
    );

    // Open the existing destination read-write. We do NOT create it
    // (it must exist — we checked above) and we use WAL mode so concurrent
    // readers (Martin) see consistent snapshots.
    let mut conn: SqliteConnection = SqliteConnectOptions::new()
        .filename(output_str)
        .create_if_missing(false)
        .read_only(false)
        .connect()
        .await
        .map_err(|e| TilegenError::TileGeneration {
            layer: output.display().to_string(),
            message: format!("failed to open existing mbtiles: {e}"),
        })?;

    // Pragmas: use WAL for safe concurrent reads, normal sync for speed.
    conn.execute("PRAGMA journal_mode = WAL").await?;
    conn.execute("PRAGMA synchronous = NORMAL").await?;
    tracing::debug!(output = %output.display(), "WAL mode set");

    // Attach the tmp database. We can't use bind parameters in ATTACH
    // so we have to interpolate the path; we just verified it's valid UTF-8
    // and tilegen controls both paths, so there's no injection vector.
    let attach_sql = format!("ATTACH DATABASE '{}' AS new", tmp_str.replace('\'', "''"));
    conn.execute(attach_sql.as_str()).await?;
    tracing::debug!(output = %output.display(), "Attached tmp database");

    // Copy in a single transaction so readers always see a consistent state.
    let copy_started = std::time::Instant::now();
    let mut tx = conn.begin().await?;
    tx.execute("DELETE FROM main.tiles").await?;
    tx.execute("INSERT INTO main.tiles SELECT * FROM new.tiles").await?;
    tx.execute("DELETE FROM main.metadata").await?;
    tx.execute("INSERT INTO main.metadata SELECT * FROM new.metadata").await?;
    tx.commit().await?;
    tracing::info!(
        output = %output.display(),
        copy_secs = copy_started.elapsed().as_secs(),
        "SQL copy committed"
    );

    // From this point on, the destination already has the new data and Martin
    // will serve it on its next query. Any error in DETACH/close/cleanup is
    // a soft warning — we don't propagate it because the actual replacement
    // succeeded.
    if let Err(e) = conn.execute("DETACH DATABASE new").await {
        tracing::warn!(output = %output.display(), "DETACH failed (data already committed): {e}");
    }
    // Switch back to DELETE journal mode and checkpoint any WAL content into
    // the main database file. Without this, the file header stays marked as
    // WAL, and the next process that opens the file (typically Martin on
    // container restart) fails with SQLITE_CANTOPEN because its sqlite
    // binding refuses to open a WAL-mode file when the matching -wal/-shm
    // sidecar files are missing. The running Martin process keeps its open
    // connection undisturbed — this only affects cold-open behavior.
    if let Err(e) = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").await {
        tracing::warn!(output = %output.display(), "wal_checkpoint failed: {e}");
    }
    if let Err(e) = conn.execute("PRAGMA journal_mode = DELETE").await {
        tracing::warn!(output = %output.display(), "journal_mode=DELETE failed: {e}");
    }
    if let Err(e) = conn.close().await {
        tracing::warn!(output = %output.display(), "close failed (data already committed): {e}");
    }

    if let Err(e) = std::fs::remove_file(tmp) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(path = %tmp.display(), "Failed to remove tmp file after copy: {e}");
        }
    }

    tracing::info!(
        output = %output.display(),
        total_secs = started.elapsed().as_secs(),
        "In-place mbtiles replacement complete"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;

    /// Build a minimal MBTiles file with the given tile data and return the path.
    /// Returns the temp directory (kept alive by the caller) and the file path.
    async fn make_mbtiles(name: &str, tiles: &[(u8, u32, u32, &[u8])]) -> std::path::PathBuf {
        let tmp_dir = std::env::temp_dir().join(format!("tilegen-test-{}-{}", name, std::process::id()));
        std::fs::create_dir_all(&tmp_dir).unwrap();
        let path = tmp_dir.join(format!("{name}.mbtiles"));
        if path.exists() {
            std::fs::remove_file(&path).unwrap();
        }

        let mut conn = SqliteConnectOptions::new()
            .filename(path.to_str().unwrap())
            .create_if_missing(true)
            .connect()
            .await
            .unwrap();
        conn.execute("CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT)").await.unwrap();
        conn.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB, PRIMARY KEY (zoom_level, tile_column, tile_row))").await.unwrap();
        sqlx::query("INSERT INTO metadata (name, value) VALUES (?, ?)")
            .bind("name").bind(name)
            .execute(&mut conn).await.unwrap();
        for (z, x, y, data) in tiles {
            sqlx::query("INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)")
                .bind(*z as i64).bind(*x as i64).bind(*y as i64).bind(*data)
                .execute(&mut conn).await.unwrap();
        }
        conn.close().await.unwrap();
        path
    }

    async fn count_tiles(path: &std::path::Path) -> i64 {
        let mut conn = SqliteConnectOptions::new()
            .filename(path.to_str().unwrap())
            .read_only(true)
            .connect()
            .await
            .unwrap();
        let row = sqlx::query("SELECT COUNT(*) FROM tiles").fetch_one(&mut conn).await.unwrap();
        let count: i64 = row.get(0);
        conn.close().await.unwrap();
        count
    }

    async fn first_tile_data(path: &std::path::Path) -> Vec<u8> {
        let mut conn = SqliteConnectOptions::new()
            .filename(path.to_str().unwrap())
            .read_only(true)
            .connect()
            .await
            .unwrap();
        let row = sqlx::query("SELECT tile_data FROM tiles ORDER BY zoom_level, tile_column, tile_row LIMIT 1").fetch_one(&mut conn).await.unwrap();
        let data: Vec<u8> = row.get(0);
        conn.close().await.unwrap();
        data
    }

    #[tokio::test]
    async fn first_run_renames_when_output_does_not_exist() {
        let tmp = make_mbtiles("first_tmp", &[(14, 1, 2, b"hello")]).await;
        let output = tmp.parent().unwrap().join("first_output.mbtiles");
        assert!(!output.exists(), "output should not exist beforehand");

        replace_mbtiles_in_place(&tmp, &output).await.unwrap();

        assert!(output.exists(), "output must exist after rename");
        assert!(!tmp.exists(), "tmp file must be gone after rename");
        assert_eq!(count_tiles(&output).await, 1);
    }

    #[tokio::test]
    async fn second_run_preserves_inode_and_replaces_data() {
        let output = make_mbtiles("second_output", &[(14, 1, 2, b"OLD")]).await;
        let tmp = make_mbtiles("second_tmp", &[(14, 5, 6, b"NEW1"), (14, 7, 8, b"NEW2")]).await;

        // Capture inode before
        let inode_before = std::fs::metadata(&output).unwrap();
        let ino_before = std::os::unix::fs::MetadataExt::ino(&inode_before);

        replace_mbtiles_in_place(&tmp, &output).await.unwrap();

        let inode_after = std::fs::metadata(&output).unwrap();
        let ino_after = std::os::unix::fs::MetadataExt::ino(&inode_after);
        assert_eq!(ino_before, ino_after, "inode must be preserved");
        assert!(!tmp.exists(), "tmp file must be gone");

        let count = count_tiles(&output).await;
        assert_eq!(count, 2, "expected 2 new tiles");

        let first = first_tile_data(&output).await;
        assert!(first.starts_with(b"NEW"), "tile data should be from the new file, got {:?}", first);
    }

    #[tokio::test]
    async fn second_run_clears_metadata_too() {
        let output = make_mbtiles("meta_output", &[]).await;
        let tmp = make_mbtiles("meta_tmp", &[]).await;

        // Add a custom metadata row to output that should NOT survive
        let mut conn = SqliteConnectOptions::new()
            .filename(output.to_str().unwrap())
            .connect()
            .await
            .unwrap();
        sqlx::query("INSERT INTO metadata (name, value) VALUES (?, ?)")
            .bind("stale-key").bind("stale-value")
            .execute(&mut conn).await.unwrap();
        conn.close().await.unwrap();

        replace_mbtiles_in_place(&tmp, &output).await.unwrap();

        let mut conn = SqliteConnectOptions::new()
            .filename(output.to_str().unwrap())
            .read_only(true)
            .connect()
            .await
            .unwrap();
        let row = sqlx::query("SELECT COUNT(*) FROM metadata WHERE name = 'stale-key'")
            .fetch_one(&mut conn).await.unwrap();
        let count: i64 = row.get(0);
        conn.close().await.unwrap();
        assert_eq!(count, 0, "stale metadata row should be gone after replacement");
    }
}
