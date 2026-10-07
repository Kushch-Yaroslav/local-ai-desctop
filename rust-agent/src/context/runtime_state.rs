//! Runtime-owned state is not a human message. Accepted snapshots remain in
//! the journal; projection emits only changed sections at their original
//! boundaries. A compaction starts with a full snapshot again.
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn sections(content: &str) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    let mut plain = Vec::new();
    let mut lines = content.lines().peekable();
    while let Some(line) = lines.next() {
        let tag = line.strip_prefix('<').and_then(|rest| {
            let end = rest.find('>')?;
            let tag = &rest[..end];
            (!tag.is_empty()
                && tag.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
            .then_some(tag)
        });
        if let Some(tag) = tag {
            let close = format!("</{tag}>");
            let mut block = vec![line];
            if !line.contains(&close) {
                for next in lines.by_ref() {
                    block.push(next);
                    if next.contains(&close) {
                        break;
                    }
                }
            }
            result.insert(tag.to_owned(), block.join("\n"));
        } else {
            plain.push(line);
        }
    }
    let plain = plain.join("\n").trim().to_owned();
    if !plain.is_empty() {
        result.insert("instructions".into(), plain);
    }
    result
}

pub fn message(previous: Option<&str>, current: &str) -> Option<Value> {
    let before = previous.map(sections).unwrap_or_default();
    let after = sections(current);
    let mut changes = Vec::new();
    for (key, value) in &after {
        if before.get(key) != Some(value) {
            changes.push(value.clone());
        }
    }
    for key in before.keys().filter(|key| !after.contains_key(*key)) {
        changes.push(format!("Runtime section cleared: {key}."));
    }
    if changes.is_empty() {
        return None;
    }
    Some(json!({"role":"runtime", "content":format!(
        "[AGENT RUNTIME STATE — NOT A USER MESSAGE]\n{}\n{}",
        if previous.is_some() { "Changed sections; these supersede their earlier values. Other sections are unchanged." }
        else { "Current runtime state." },
        changes.join("\n")
    )}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_changed_sections_are_sent_and_removed_sections_are_cleared() {
        let old = "<plan>\ns1 active\n</plan>\n<deliverables>\nd1 pending\n</deliverables>\nLanguage: English";
        assert!(message(Some(old), old).is_none());
        let new = old.replace("s1 active", "s1 done");
        let update = message(Some(old), &new).unwrap();
        assert_eq!(update["role"], "runtime");
        let text = update["content"].as_str().unwrap();
        assert!(text.contains("s1 done"));
        assert!(!text.contains("d1 pending"));
        assert!(!text.contains("Language:"));
        let removed = message(Some(old), "<plan>\ns1 active\n</plan>").unwrap();
        assert!(removed["content"].as_str().unwrap().contains("cleared: deliverables"));
    }
}
