//! ARIS Meta-Optimize: Safe apply logic.
//!
//! Proposals are stored in `~/.config/aris/meta/proposals/` as JSON files.
//! `/meta-optimize apply N` reads a proposal, validates it, and writes the
//! patched SKILL.md to `~/.config/aris/skills/<skill>/SKILL.md`.
//!
//! The model NEVER controls the destination path — it is computed by this
//! Rust code from the validated skill name.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

// Skill name validation: lowercase alphanumeric + hyphens only (enforced by is_valid_skill_name).

/// Directory for meta-optimize proposals.
fn proposals_dir() -> PathBuf {
    let home = runtime::home_dir();
    PathBuf::from(home)
        .join(".config")
        .join("aris")
        .join("meta")
        .join("proposals")
}

/// Directory for meta-optimize backups.
fn backups_dir() -> PathBuf {
    let home = runtime::home_dir();
    PathBuf::from(home)
        .join(".config")
        .join("aris")
        .join("meta")
        .join("backups")
}

/// Directory for user skills (highest priority).
fn user_skills_dir() -> PathBuf {
    let home = runtime::home_dir();
    PathBuf::from(home)
        .join(".config")
        .join("aris")
        .join("skills")
}

/// Optimizations log file.
fn optimizations_log_path() -> PathBuf {
    let home = runtime::home_dir();
    PathBuf::from(home)
        .join(".config")
        .join("aris")
        .join("meta")
        .join("optimizations.jsonl")
}

/// A meta-optimize proposal stored on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetaProposal {
    pub id: usize,
    pub target_skill: String,
    pub description: String,
    pub rationale: String,
    pub reviewer_score: Option<f64>,
    pub reviewer_notes: Option<String>,
    /// The full new SKILL.md content to write.
    pub new_content: String,
    /// SHA-256 hash of the original SKILL.md (for staleness check).
    pub original_hash: Option<String>,
    pub created_at: String,
    pub status: String,
}

/// Validate a skill name: only lowercase alphanumeric and hyphens.
fn is_valid_skill_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 60 {
        return false;
    }
    let first = name.as_bytes()[0];
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    name.bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// List all pending proposals.
pub fn list_proposals() -> Result<Vec<MetaProposal>, String> {
    let dir = proposals_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut proposals = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            // Reject symlinks
            if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(proposal) = serde_json::from_str::<MetaProposal>(&content) {
                    proposals.push(proposal);
                }
            }
        }
    }
    proposals.sort_by_key(|p| p.id);
    Ok(proposals)
}

/// Apply a proposal by ID.
pub fn apply_proposal(id: usize) -> Result<String, String> {
    let proposals = list_proposals()?;
    let proposal = proposals
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("Proposal #{id} not found"))?;

    if proposal.status == "applied" {
        return Err(format!("Proposal #{id} has already been applied"));
    }

    // Validate skill name (strict slug regex)
    if !is_valid_skill_name(&proposal.target_skill) {
        return Err(format!(
            "Invalid skill name '{}': must be lowercase alphanumeric + hyphens only",
            proposal.target_skill
        ));
    }

    // Compute destination path — hardcoded, model cannot influence
    let skill_dir = user_skills_dir().join(&proposal.target_skill);
    let target_path = skill_dir.join("SKILL.md");

    // Reject if skill directory or target is a symlink
    if is_symlink(&skill_dir) {
        return Err(format!(
            "Skill directory is a symlink, refusing: {}",
            skill_dir.display()
        ));
    }
    if is_symlink(&target_path) {
        return Err(format!(
            "Target path is a symlink, refusing: {}",
            target_path.display()
        ));
    }

    // Verify canonical path is under user_skills_dir (defense against path tricks)
    // For new files: verify the parent resolves correctly
    let check_path = if target_path.exists() {
        target_path.clone()
    } else {
        // For new files, create the dir first so we can canonicalize
        fs::create_dir_all(&skill_dir).map_err(|e| e.to_string())?;
        skill_dir.clone()
    };
    if let Ok(canonical) = check_path.canonicalize() {
        let skills_root = user_skills_dir();
        let canonical_root = if skills_root.exists() {
            skills_root.canonicalize().map_err(|e| e.to_string())?
        } else {
            fs::create_dir_all(&skills_root).map_err(|e| e.to_string())?;
            skills_root.canonicalize().map_err(|e| e.to_string())?
        };
        if !canonical.starts_with(&canonical_root) {
            return Err(format!(
                "Target path escapes skills directory: {}",
                canonical.display()
            ));
        }
    }

    // Check staleness: verify current file matches expected hash
    if target_path.exists() {
        if let Some(ref expected_hash) = proposal.original_hash {
            let current = fs::read_to_string(&target_path).map_err(|e| e.to_string())?;
            let current_hash = sha256_hex(current.as_bytes());
            if &current_hash != expected_hash {
                return Err(format!(
                    "SKILL.md has been modified since proposal was created (hash mismatch). \
                     Please re-run /meta-optimize to generate fresh proposals."
                ));
            }
        }
    }

    // Backup original if it exists
    if target_path.exists() {
        let backup_dir = backups_dir();
        fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
        let backup_name = format!(
            "{}_{}.SKILL.md",
            proposal.target_skill,
            chrono_simple_now()
        );
        let backup_path = backup_dir.join(backup_name);
        fs::copy(&target_path, &backup_path).map_err(|e| e.to_string())?;
    }

    // Write new SKILL.md via temp file + rename (atomic)
    // Use a unique temp name to prevent symlink attacks on .tmp file
    let tmp_name = format!(".SKILL.md.tmp.{}", std::process::id());
    fs::create_dir_all(&skill_dir).map_err(|e| e.to_string())?;
    let tmp_path = skill_dir.join(&tmp_name);
    // Reject if tmp path is somehow a symlink
    if is_symlink(&tmp_path) {
        let _ = fs::remove_file(&tmp_path);
    }
    fs::write(&tmp_path, &proposal.new_content).map_err(|e| e.to_string())?;
    // On Windows, rename fails if target exists — remove first
    if target_path.exists() {
        let _ = fs::remove_file(&target_path);
    }
    fs::rename(&tmp_path, &target_path).map_err(|e| e.to_string())?;

    // Log the change
    let log_entry = serde_json::json!({
        "ts": runtime::event_sink::now_iso8601(),
        "action": "apply",
        "proposal_id": id,
        "target_skill": proposal.target_skill,
        "description": proposal.description,
        "target_path": target_path.display().to_string(),
    });
    let log_path = optimizations_log_path();
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "{}", log_entry)
        });

    // Mark proposal as applied
    let mut applied = proposal.clone();
    applied.status = "applied".to_string();
    let proposal_path = proposals_dir().join(format!("proposal_{id}.json"));
    let _ = fs::write(
        &proposal_path,
        serde_json::to_string_pretty(&applied).unwrap_or_default(),
    );

    Ok(format!(
        "\x1b[1;32m✓\x1b[0m Applied proposal #{id} to {}\n  \
         Skill: {}\n  \
         Description: {}\n  \
         Backup saved to ~/.config/aris/meta/backups/",
        target_path.display(),
        proposal.target_skill,
        proposal.description,
    ))
}

/// Show status of meta-optimize: event count, proposals, etc.
pub fn status_report() -> Result<String, String> {
    let events_path = runtime::event_sink::JsonlEventSink::default_path();
    let event_count = if events_path.exists() {
        fs::read_to_string(&events_path)
            .map(|c| c.lines().count())
            .unwrap_or(0)
    } else {
        0
    };

    let proposals = list_proposals()?;
    let pending = proposals.iter().filter(|p| p.status != "applied").count();
    let applied = proposals.iter().filter(|p| p.status == "applied").count();

    let logging_level = std::env::var("ARIS_META_LOGGING").unwrap_or_else(|_| "off".into());

    let mut report = format!(
        "\x1b[1mMeta-Optimize Status\x1b[0m\n\n  \
         Logging level    {logging_level}\n  \
         Events logged    {event_count}\n  \
         Proposals        {pending} pending, {applied} applied\n"
    );

    if !proposals.is_empty() {
        report.push_str("\n\x1b[1mProposals\x1b[0m\n\n");
        for p in &proposals {
            let icon = if p.status == "applied" {
                "\x1b[1;32m✓\x1b[0m"
            } else {
                "\x1b[1;33m○\x1b[0m"
            };
            let score = p
                .reviewer_score
                .map_or(String::new(), |s| format!(" (score: {s:.0}/10)"));
            report.push_str(&format!(
                "  {icon} #{}: {} → /{}{score}\n",
                p.id, p.description, p.target_skill
            ));
        }
    }

    if event_count < 5 {
        report.push_str(&format!(
            "\n  \x1b[2mNeed at least 5 skill invocations to run optimization ({event_count}/5).\x1b[0m\n"
        ));
    }

    Ok(report)
}

fn is_symlink(path: &std::path::Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(data);
    hash.iter().map(|b| format!("{b:02x}")).collect()
}

fn chrono_simple_now() -> String {
    runtime::event_sink::now_iso8601()
        .replace(':', "-")
        .replace('T', "_")
        .replace('Z', "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_skill_names() {
        assert!(is_valid_skill_name("auto-review-loop"));
        assert!(is_valid_skill_name("paper-write"));
        assert!(is_valid_skill_name("arxiv"));
        assert!(is_valid_skill_name("dse-loop"));
    }

    #[test]
    fn test_invalid_skill_names() {
        assert!(!is_valid_skill_name(""));
        assert!(!is_valid_skill_name(".."));
        assert!(!is_valid_skill_name("../../.zshrc"));
        assert!(!is_valid_skill_name("Auto-Review"));  // uppercase
        assert!(!is_valid_skill_name("-starts-with-hyphen"));
        assert!(!is_valid_skill_name("has space"));
        assert!(!is_valid_skill_name("has/slash"));
        assert!(!is_valid_skill_name("has.dot"));
    }
}
