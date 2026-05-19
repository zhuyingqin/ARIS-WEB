// aris-cli build script.
//
// Injects ARIS_BUILD_DATE into the binary so `aris --version` can display
// the actual compile date instead of the legacy hardcoded "2026-03-31"
// const that survived the v0.4.6 system-prompt date fix (which only
// covered ProjectContext::current_date, not the --version output).
//
// Strategy: ask the OS `date` command for YYYY-MM-DD. POSIX `date
// '+%Y-%m-%d'` works on macOS, Linux, and any shell with date(1) (the
// release-build CI runners are ubuntu-latest). On Windows or when date
// is unavailable for any other reason we fall back to "unknown" so the
// build never breaks on this cosmetic concern.

use std::process::Command;

fn main() {
    // Re-run only when this build script itself changes — the date itself
    // is intentionally NOT a build trigger (otherwise every cargo build
    // would change the env, invalidating the binary's cache key).
    println!("cargo:rerun-if-changed=build.rs");

    let date = Command::new("date")
        .arg("+%Y-%m-%d")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout).ok()
            } else {
                None
            }
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=ARIS_BUILD_DATE={date}");
}
