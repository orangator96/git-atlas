use axum::{
    extract::{Path, State},
    Json,
};
use serde::Serialize;
use std::sync::Arc;

use crate::{
    error::{ApiResult, AppError},
    git::containment::{self, ContainingRef},
    git::graph::RefKind,
    state::AppState,
};

/// Response for GET /api/v1/commits/:oid/containment.
///
/// Splits the ref facts into the two things the commit pane renders separately:
/// `tips` (refs pointing *exactly at* this commit) and `contained_in` (all refs
/// whose history includes it, tips included). Plus a small precomputed
/// `summary` so the UI can lead with the answer ("first released in vX, on
/// main") without re-deriving it.
#[derive(Debug, Serialize)]
pub struct ContainmentResponse {
    pub oid: String,
    /// Refs whose tip IS this commit (the "At this commit" section).
    pub tips: Vec<ContainingRef>,
    /// All refs that contain this commit in ancestry (the "Contained in"
    /// section). Includes the tips — the UI de-emphasizes rather than removes
    /// the overlap so group counts stay honest.
    pub contained_in: Vec<ContainingRef>,
    /// Precomputed lead summary.
    pub summary: ContainmentSummary,
}

#[derive(Debug, Serialize)]
pub struct ContainmentSummary {
    /// Earliest tag (by tip time) that contains this commit — "first released
    /// in". `None` if no tag contains it.
    pub earliest_tag: Option<String>,
    /// Name of the default branch if it contains this commit — answers "is this
    /// on main?". `None` if the default branch does not contain it.
    pub on_default_branch: Option<String>,
    /// Total counts per kind, for the collapsed group headers.
    pub branch_count: usize,
    pub remote_count: usize,
    pub tag_count: usize,
}

fn summarize(refs: &[ContainingRef]) -> ContainmentSummary {
    let mut branch_count = 0;
    let mut remote_count = 0;
    let mut tag_count = 0;
    let mut earliest_tag: Option<&ContainingRef> = None;
    let mut on_default_branch: Option<String> = None;

    for r in refs {
        match r.kind {
            RefKind::Branch => {
                branch_count += 1;
                if r.is_default_branch {
                    on_default_branch = Some(r.name.clone());
                }
            }
            RefKind::RemoteBranch => remote_count += 1,
            RefKind::Tag => {
                tag_count += 1;
                // Earliest = smallest tip_ts; a tag with no timestamp sorts last.
                earliest_tag = match (earliest_tag, r.tip_ts) {
                    (None, _) => Some(r),
                    (Some(cur), Some(ts)) => {
                        if cur.tip_ts.is_none_or(|c| ts < c) {
                            Some(r)
                        } else {
                            Some(cur)
                        }
                    }
                    (Some(cur), None) => Some(cur),
                };
            }
            RefKind::Head => {}
        }
    }

    ContainmentSummary {
        earliest_tag: earliest_tag.map(|r| r.name.clone()),
        on_default_branch,
        branch_count,
        remote_count,
        tag_count,
    }
}

/// GET /api/v1/commits/:oid/containment — which branches/tags contain this
/// commit. Served from a fingerprint-keyed cache; rebuilt only when the repo's
/// ref set changes.
pub async fn get_containment(
    State(state): State<AppState>,
    Path(oid): Path<String>,
) -> ApiResult<Json<ContainmentResponse>> {
    let path = state.repo_path().await?;

    // Compute the current ref-set fingerprint (cheap) to decide cache validity.
    let fp_path = path.clone();
    let fingerprint = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&fp_path).map_err(AppError::Git)?;
        containment::refs_fingerprint(&repo)
    })
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))??;

    // Serve from cache when the ref set is unchanged; otherwise rebuild the
    // whole-repo map once and memoize it.
    let map = if let Some(cached) = state.cached_containment(fingerprint).await {
        cached
    } else {
        let build_path = path.clone();
        let fresh = tokio::task::spawn_blocking(move || {
            let repo = git2::Repository::open(&build_path).map_err(AppError::Git)?;
            containment::compute_containment(&repo)
        })
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))??;
        let arc = Arc::new(fresh);
        state.cache_containment(fingerprint, arc.clone()).await;
        arc
    };

    // Normalize the OID (accept short OIDs / refspecs) so the lookup key matches
    // the full hex OIDs stored in the map.
    let full_oid = {
        let resolve_path = path.clone();
        let oid_in = oid.clone();
        tokio::task::spawn_blocking(move || {
            let repo = git2::Repository::open(&resolve_path).map_err(AppError::Git)?;
            crate::git::resolve_ref(&repo, &oid_in)
        })
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))??
    };

    let contained_in: Vec<ContainingRef> = map.get(&full_oid).cloned().unwrap_or_default();
    let tips: Vec<ContainingRef> = contained_in.iter().filter(|r| r.is_tip).cloned().collect();
    let summary = summarize(&contained_in);

    Ok(Json(ContainmentResponse {
        oid: full_oid,
        tips,
        contained_in,
        summary,
    }))
}
