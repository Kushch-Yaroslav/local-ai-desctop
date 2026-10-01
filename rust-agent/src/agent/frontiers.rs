//! Source-backed execution dependencies. This is an evidence edge index, not a
//! task plan: only literal local call targets discovered in inspected source
//! can become frontiers. Imports and incidental references do not.
use crate::agent::evidence::Observation;
use crate::agent::working_evidence::EstablishedEvidence;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceFrontier {
    pub id: String,
    pub from_observation: String,
    pub source: String,
    pub target: String,
    /// Canonical local file selected from project serving evidence. Older
    /// journals omit this and are resolved against the project on use.
    #[serde(default)]
    pub resolved_path: Option<String>,
    #[serde(default)]
    pub project_relative_path: Option<String>,
    #[serde(default)]
    pub resolution: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrontierDisposition {
    pub id: String,
    pub outcome: String,
    pub reason: String,
    pub observation_id: Option<String>,
}

/// Intentionally recognizes only static local execution edges. Dynamic calls
/// cannot be inferred safely from a bounded source observation.
pub fn discover(
    observation: &Observation,
    result: &str,
    root: Option<&Path>,
) -> Vec<EvidenceFrontier> {
    if observation.error || observation.tool != "read_file" {
        return Vec::new();
    }
    let Some(source) = observation.source.as_deref() else {
        return Vec::new();
    };
    let body = serde_json::from_str::<serde_json::Value>(result)
        .ok()
        .and_then(|v| v.get("content").and_then(|c| c.as_str()).map(str::to_owned))
        .unwrap_or_else(|| result.to_owned());
    let mut targets = Vec::new();
    for marker in [
        "fetch(",
        "axios.get(",
        "axios.post(",
        "axios.put(",
        "axios.delete(",
    ] {
        for (at, _) in body.match_indices(marker) {
            let rest = body[at + marker.len()..].trim_start();
            if let Some(target) = quoted_target(rest) {
                targets.push(target);
            }
        }
    }
    for marker in ["action=", "action ="] {
        for (at, _) in body.match_indices(marker) {
            if let Some(target) = quoted_target(body[at + marker.len()..].trim_start()) {
                targets.push(target);
            }
        }
    }
    targets.sort();
    targets.dedup();
    targets
        .into_iter()
        .enumerate()
        .filter_map(|(index, target)| {
            let root = root?.canonicalize().ok()?;
            let (path, provenance) = resolve_local_target(source, &target, &root)?;
            let relative = path
                .strip_prefix(&root)
                .ok()?
                .to_string_lossy()
                .into_owned();
            Some(EvidenceFrontier {
                id: format!("frontier-{}-{index:02}", observation.id),
                from_observation: observation.id.clone(),
                source: source.to_owned(),
                target,
                resolved_path: Some(path.to_string_lossy().into_owned()),
                project_relative_path: Some(relative),
                resolution: Some(provenance),
            })
        })
        .collect()
}

/// A browser URL is relative to the document base, never to a TS/JS source
/// path. Only project files with a demonstrated serving map become mandatory
/// dependencies. Missing or ambiguous paths remain leads, not frontiers.
pub fn resolve_local_target(source: &str, target: &str, root: &Path) -> Option<(PathBuf, String)> {
    let root = root.canonicalize().ok()?;
    let source = Path::new(source).canonicalize().ok()?;
    if !source.starts_with(&root) || target.starts_with("//") || target.contains("://") {
        return None;
    }
    let literal = target.split(['?', '#']).next()?;
    let relative = literal.trim_start_matches('/').trim_start_matches("./");
    if relative.is_empty()
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == ".." || part == ".")
    {
        return None;
    }
    let public = static_public_root(&root);
    let is_document = source
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e, "html" | "htm"));
    let is_browser_module = source.starts_with(root.join("src"))
        && source
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| matches!(e, "tsx" | "jsx" | "ts" | "js"));
    let is_browser_source = is_document || is_browser_module;
    if !is_browser_source {
        return None;
    }
    // Root-relative references have a stable browser location. Relative
    // references need an explicit root base in the project document.
    let document = if is_document {
        source.clone()
    } else {
        root.join("index.html")
    };
    let root_base = std::fs::read_to_string(document)
        .ok()
        .is_some_and(|html| html.contains("<base href=\"/\"") || html.contains("<base href='/'"));
    if (literal.starts_with('/') || root_base) && public.is_some() {
        let public = public.as_deref()?;
        let path = public.join(relative).canonicalize().ok()?;
        if path.starts_with(&public) && path.is_file() {
            return Some((
                path,
                if literal.starts_with('/') {
                    "configured static public root; root-relative browser URL"
                } else {
                    "configured static public root; document base /"
                }
                .into(),
            ));
        }
    }
    // A standalone document in the public tree has a known document-relative
    // location even without an application-wide base tag.
    if !literal.starts_with('/') && is_document {
        let public = public.as_deref()?;
        if source.starts_with(&public) {
            let path = source.parent()?.join(relative).canonicalize().ok()?;
            if path.starts_with(&public) && path.is_file() {
                return Some((path, "document-relative public file".into()));
            }
        }
    }
    None
}

fn static_public_root(root: &Path) -> Option<PathBuf> {
    let package: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("package.json")).ok()?).ok()?;
    let vite = package.pointer("/devDependencies/vite").is_some()
        || package.pointer("/dependencies/vite").is_some();
    if !vite {
        return None;
    }
    let config = ["vite.config.ts", "vite.config.js", "vite.config.mjs"]
        .into_iter()
        .find_map(|name| std::fs::read_to_string(root.join(name)).ok())?;
    let configured = if let Some((_, rest)) = config.split_once("publicDir:") {
        let rest = rest.trim_start();
        if rest.starts_with("false") {
            return None;
        }
        let quote = rest.chars().next()?;
        if !matches!(quote, '\'' | '"') {
            return None;
        }
        rest[quote.len_utf8()..].split(quote).next()?.to_owned()
    } else {
        "public".into()
    };
    if configured.is_empty()
        || Path::new(&configured).is_absolute()
        || configured.split('/').any(|part| part == "..")
    {
        return None;
    }
    let public = root.join(configured).canonicalize().ok()?;
    public.starts_with(root).then_some(public)
}

fn quoted_target(text: &str) -> Option<String> {
    let quote = text.chars().next()?;
    if !matches!(quote, '\'' | '"' | '`') {
        return None;
    }
    let raw = text[quote.len_utf8()..].split(quote).next()?;
    if raw.starts_with("//") || raw.contains("://") || raw.starts_with("data:") {
        return None;
    }
    let target = raw.split(['?', '#']).next()?;
    if target.is_empty()
        || target.contains(['$', '{', '}', '\\'])
        || target.starts_with("http:")
        || target.starts_with("https:")
        || target.starts_with("#")
        || target.contains("..")
        || target.chars().any(char::is_whitespace)
    {
        return None;
    }
    // A literal endpoint, file, or route is useful. Bare API nouns are often
    // external runtime routes with no source file to inspect.
    if !target.contains('/') && !target.contains('.') {
        return None;
    }
    Some(target.to_owned())
}

pub fn target_observation<'a>(
    frontier: &EvidenceFrontier,
    observations: &'a [Observation],
) -> Option<&'a Observation> {
    observations.iter().find(|o| {
        !o.error
            && o.tool == "read_file"
            && o.id != frontier.from_observation
            && o.source
                .as_deref()
                .is_some_and(|source| matches_target_source(frontier, source))
    })
}

pub fn matches_target_source(frontier: &EvidenceFrontier, source: &str) -> bool {
    frontier.resolved_path.as_deref() == Some(source)
        || frontier.project_relative_path.as_deref() == Some(source.trim_start_matches("./"))
}

pub fn resolved_by_evidence(
    frontier: &EvidenceFrontier,
    observations: &[Observation],
    facts: &[EstablishedEvidence],
) -> bool {
    target_observation(frontier, observations).is_some_and(|target| {
        facts.iter().any(|fact| {
            fact.observation_id.as_deref() == Some(target.id.as_str())
                && matches!(
                    fact.origin.as_str(),
                    "agent-reported direct" | "agent established from observation"
                )
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn obs(id: &str, source: &str) -> Observation {
        Observation {
            id: id.into(),
            event_id: "evt-1".into(),
            call_id: "call".into(),
            tool: "read_file".into(),
            source: Some(source.into()),
            source_revision: None,
            requested_range: None,
            returned_range: None,
            error: false,
            body_sha256: String::new(),
            body_bytes: 0,
        }
    }
    fn fixture(name: &str, root_base: bool) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("frontier-resolution-{name}-{}", std::process::id()));
        fs::create_dir_all(root.join("src/forms")).unwrap();
        fs::create_dir_all(root.join("public/pages")).unwrap();
        fs::write(root.join("src/forms/Form.tsx"), "fetch('api.php')").unwrap();
        fs::write(root.join("public/api.php"), "<?php echo 'ok';").unwrap();
        fs::write(
            root.join("index.html"),
            if root_base {
                "<base href=\"/\">"
            } else {
                "<html></html>"
            },
        )
        .unwrap();
        fs::write(
            root.join("package.json"),
            r#"{"devDependencies":{"vite":"*"}}"#,
        )
        .unwrap();
        fs::write(
            root.join("vite.config.ts"),
            "export default defineConfig({})",
        )
        .unwrap();
        root
    }
    #[test]
    fn project_public_root_resolves_browser_urls_without_source_relative_confusion() {
        let root = fixture("public", true);
        let source = root
            .join("src/forms/Form.tsx")
            .to_string_lossy()
            .into_owned();
        let edges = discover(
            &obs("obs-1", &source),
            r#"{"content":"import A from './A'; import B from './B'; await fetch('api.php', {method:'POST'}); fetch('/api.php'); fetch('./api.php');"}"#,
            Some(&root),
        );
        assert_eq!(edges.len(), 3);
        for edge in &edges {
            assert_eq!(
                edge.resolved_path.as_deref(),
                Some(
                    root.join("public/api.php")
                        .canonicalize()
                        .unwrap()
                        .to_str()
                        .unwrap()
                )
            );
            assert!(target_observation(
                edge,
                &[obs("obs-2", edge.resolved_path.as_deref().unwrap())]
            )
            .is_some());
        }
        assert!(edges.iter().all(|edge| !edge
            .resolved_path
            .as_deref()
            .unwrap()
            .contains("src/forms/api.php")));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn standalone_public_document_resolves_source_local_dependency() {
        let root = fixture("local", false);
        fs::write(
            root.join("public/pages/form.html"),
            "<form action='./submit.php'>",
        )
        .unwrap();
        fs::write(root.join("public/pages/submit.php"), "<?php").unwrap();
        let source = root
            .join("public/pages/form.html")
            .to_string_lossy()
            .into_owned();
        let edges = discover(
            &obs("obs-1", &source),
            "<form action='./submit.php'>",
            Some(&root),
        );
        assert_eq!(edges.len(), 1);
        assert_eq!(
            edges[0].resolved_path.as_deref(),
            Some(
                root.join("public/pages/submit.php")
                    .canonicalize()
                    .unwrap()
                    .to_str()
                    .unwrap()
            )
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn remote_dynamic_missing_and_unbased_relative_urls_are_not_mandatory() {
        let root = fixture("ambiguous", false);
        let source = root
            .join("src/forms/Form.tsx")
            .to_string_lossy()
            .into_owned();
        assert!(discover(
            &obs("obs-1", &source),
            "fetch(url); fetch('https://example.com/api'); fetch(`${base}/api`); fetch('api.php'); fetch('/missing.php')",
            Some(&root),
        )
        .is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn disabled_public_mapping_never_invents_a_local_frontier() {
        let root = fixture("disabled", true);
        fs::write(
            root.join("vite.config.ts"),
            "export default defineConfig({ publicDir: false })",
        )
        .unwrap();
        let source = root
            .join("src/forms/Form.tsx")
            .to_string_lossy()
            .into_owned();
        assert!(discover(&obs("obs-1", &source), "fetch('api.php')", Some(&root)).is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
