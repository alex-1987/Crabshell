//! Installed font families for the font settings (the webview cannot list them under WebKitGTK).

use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FontFamily {
    pub name: String,
    /// At least one face of the family is fixed-width (suitable for the terminal).
    pub monospace: bool,
}

/// Families of all installed fonts, sorted by name. Scans the font directories, so it runs
/// off the main thread (async command).
#[tauri::command]
pub(crate) async fn system_fonts() -> Vec<FontFamily> {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();
    let mut families: BTreeMap<String, bool> = BTreeMap::new();
    for face in database.faces() {
        // The first name is the English family name.
        if let Some((name, _)) = face.families.first() {
            if usable_name(name) {
                *families.entry(name.clone()).or_default() |= face.monospaced;
            }
        }
    }
    sorted(families)
}

fn sorted(families: BTreeMap<String, bool>) -> Vec<FontFamily> {
    let mut list: Vec<FontFamily> = families
        .into_iter()
        .map(|(name, monospace)| FontFamily { name, monospace })
        .collect();
    list.sort_by_key(|family| family.name.to_lowercase());
    list
}

/// Same rule as the settings validation, so every listed font can also be saved.
pub(crate) fn usable_name(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty()
        && name.chars().count() <= 100
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || " -_.&+()".contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_names_are_safe_for_css() {
        assert!(usable_name("JetBrains Mono"));
        assert!(usable_name("Noto Sans CJK JP"));
        assert!(usable_name("Fira Code (Retina)"));
        assert!(!usable_name(""));
        assert!(!usable_name("Evil\"; } body { color: red"));
        assert!(!usable_name("a'b"));
        assert!(!usable_name(&"x".repeat(101)));
    }

    #[test]
    fn families_sort_case_insensitively() {
        let mut families = BTreeMap::new();
        families.insert("noto Sans".to_string(), false);
        families.insert("DejaVu Sans Mono".to_string(), true);
        families.insert("Cantarell".to_string(), false);
        let names: Vec<_> = sorted(families).into_iter().map(|f| f.name).collect();
        assert_eq!(names, ["Cantarell", "DejaVu Sans Mono", "noto Sans"]);
    }
}

#[cfg(test)]
mod system_tests {
    /// Lists the fonts of this machine: `cargo test -- --ignored system_fonts --nocapture`.
    #[test]
    #[ignore]
    fn system_fonts_lists_installed_families() {
        let fonts = tauri::async_runtime::block_on(super::system_fonts());
        let mono: Vec<_> = fonts
            .iter()
            .filter(|f| f.monospace)
            .map(|f| f.name.as_str())
            .collect();
        println!(
            "{} families, {} monospace: {:?}",
            fonts.len(),
            mono.len(),
            mono
        );
        assert!(!fonts.is_empty());
    }
}
