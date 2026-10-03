use std::collections::BTreeMap;

/// Only identities present in the current run's evidence are projected.
/// Paths, unknown identifiers and fenced source examples remain untouched.
pub fn project_answer(text: &str, references: &BTreeMap<String, String>) -> String {
    project_answer_with_prefix(text, "", references)
}

pub fn project_answer_with_prefix(
    text: &str,
    prefix: &str,
    references: &BTreeMap<String, String>,
) -> String {
    let mut output = String::new();
    let mut fence: Option<char> = None;
    for line in prefix.lines() {
        let trimmed = line.trim_start();
        let marker = if trimmed.starts_with("```") {
            Some('`')
        } else if trimmed.starts_with("~~~") {
            Some('~')
        } else {
            None
        };
        if let Some(marker) = marker {
            if fence == Some(marker) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(marker);
            }
        }
    }
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let marker = if trimmed.starts_with("```") {
            Some('`')
        } else if trimmed.starts_with("~~~") {
            Some('~')
        } else {
            None
        };
        if let Some(marker) = marker {
            if fence == Some(marker) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(marker);
            }
            output.push_str(line);
            continue;
        }
        if fence.is_some() {
            output.push_str(line);
            continue;
        }
        let mut word = String::new();
        for character in line.chars().chain(std::iter::once('\0')) {
            if character.is_alphanumeric() || matches!(character, '-' | '_' | '.' | '/' | '\\') {
                word.push(character);
            } else {
                // Sentence punctuation must not become part of a reference.
                let token = word.trim_end_matches('.');
                output.push_str(references.get(token).map(String::as_str).unwrap_or(token));
                output.push_str(&word[token.len()..]);
                word.clear();
                if character != '\0' {
                    output.push(character);
                }
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projects_only_known_prose_references_not_paths_or_source() {
        let references = BTreeMap::from([
            ("obs-00000006".into(), "src/main.rs".into()),
            ("tm-004".into(), "runtime ownership finding".into()),
        ]);
        let input = "See `obs-00000006`, tm-004. Unknown obs-00000044.\nFile data/obs-00000006.txt and symbol xobs-00000006 stay.\n```rust\nlet id = \"obs-00000006\";\n```\n";
        let shown = project_answer(input, &references);
        assert!(shown
            .starts_with("See `src/main.rs`, runtime ownership finding. Unknown obs-00000044."));
        assert!(shown.contains("data/obs-00000006.txt"));
        assert!(shown.contains("xobs-00000006"));
        assert!(shown.contains("let id = \"obs-00000006\";"));
        assert_eq!(
            project_answer_with_prefix(
                "obs-00000006\n```\nSee obs-00000006.",
                "```text\nsource example\n",
                &references
            ),
            "obs-00000006\n```\nSee src/main.rs."
        );
        assert_eq!(input, "See `obs-00000006`, tm-004. Unknown obs-00000044.\nFile data/obs-00000006.txt and symbol xobs-00000006 stay.\n```rust\nlet id = \"obs-00000006\";\n```\n");
    }
}
