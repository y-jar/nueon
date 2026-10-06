//! Collision-free, stable filenames for table files.
//!
//! A table's filename is resolved **once** and never recomputed from its
//! display name afterwards. Two tables whose names differ only by case or
//! punctuation (`"Roots"` vs `"roots"`, `"a b"` vs `"a_b"`) — which used to
//! collapse to the exact same slug and silently overwrite one another — now
//! always get distinct files. See [`resolve_new`](TableFiles::resolve_new).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::storage::{io_err, read_json, StorageError};
use crate::model::WordTable;

/// A file in `dictionary/` that exists but could not be loaded as a table.
///
/// It is never moved, renamed or deleted by the app: it is left exactly
/// where the user (or a crash) left it, reported so they can investigate,
/// and its name is reserved so a new table can never be resolved onto it.
#[derive(Debug, Clone, Serialize)]
pub struct QuarantineWarning {
    pub file_name: String,
    pub reason: String,
}

/// The stable mapping from a table's display name to its on-disk filename.
#[derive(Debug, Clone, Default)]
pub struct TableFiles {
    by_name: BTreeMap<String, String>,
    /// Every filename currently spoken for (live tables and quarantined
    /// files alike), lowercased, so two names differing only by case can
    /// never be resolved onto the same path.
    reserved_lower: BTreeSet<String>,
}

/// Lowercase-ASCII-alnum slug; non-alnum runs collapse to `_`. Unlike
/// [`crate::workspace::storage::slugify`] this does **not** fall back to
/// `"untitled"` for an empty result — callers that care about collisions
/// need to see the empty case themselves.
fn raw_slug(name: &str) -> String {
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    slug.trim_matches('_').to_string()
}

/// A short, stable hex digest of `name`, `hex_len` characters long.
fn stable_suffix(name: &str, hex_len: usize) -> String {
    let digest = Sha256::digest(name.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    hex.chars().take(hex_len.max(4)).collect()
}

impl TableFiles {
    /// The filename already resolved for `name`, if any.
    pub fn filename(&self, name: &str) -> Option<&str> {
        self.by_name.get(name).map(String::as_str)
    }

    /// Record a filename exactly as found on disk at scan time. Scanned
    /// filenames are observations, never recomputed.
    pub fn insert_existing(&mut self, name: &str, filename: String) {
        self.reserved_lower.insert(filename.to_lowercase());
        self.by_name.insert(name.to_string(), filename);
    }

    /// Reserve a filename without mapping it to any table (a quarantined
    /// file): it stays off-limits to new tables but is otherwise untouched.
    pub fn reserve_only(&mut self, filename: &str) {
        self.reserved_lower.insert(filename.to_lowercase());
    }

    /// Resolve and reserve a brand-new filename for `name`.
    ///
    /// - A non-empty slug that is not already taken (case-insensitively) is
    ///   used as-is.
    /// - An empty slug (a name with no alphanumerics at all) always gets a
    ///   hash suffix, since every such name would otherwise collide on
    ///   `"untitled"`.
    /// - Any other collision gets a hash suffix computed from the full
    ///   name, so two different names never fight over one file.
    pub fn resolve_new(&mut self, name: &str) -> String {
        let raw = raw_slug(name);
        if !raw.is_empty() && !self.reserved_lower.contains(&raw.to_lowercase()) {
            self.insert_existing(name, raw.clone());
            return raw;
        }
        let base = if raw.is_empty() {
            "untitled"
        } else {
            raw.as_str()
        };
        let mut hex_len = 8;
        loop {
            let candidate = format!("{base}-{}", stable_suffix(name, hex_len));
            if !self.reserved_lower.contains(&candidate.to_lowercase()) {
                self.insert_existing(name, candidate.clone());
                return candidate;
            }
            // A second collision at this hash length is astronomically
            // unlikely; widening it keeps resolution fully deterministic
            // instead of falling back to randomness.
            hex_len += 8;
            if hex_len > Sha256::output_size() * 2 {
                let candidate = format!("{base}-{}", uuid::Uuid::new_v4().simple());
                self.insert_existing(name, candidate.clone());
                return candidate;
            }
        }
    }

    /// Update the map after a rename: the filename never moves, only the key
    /// it is resolved under does. This is what keeps a rename from ever
    /// deleting the table's own file (the old bug this replaces).
    pub fn rename(&mut self, from: &str, to: &str) {
        if let Some(filename) = self.by_name.remove(from) {
            self.by_name.insert(to.to_string(), filename);
        }
    }

    /// Forget a table (deleted or trashed). Returns its filename. The name is
    /// only released for reuse once nothing else maps to it.
    pub fn remove(&mut self, name: &str) -> Option<String> {
        let filename = self.by_name.remove(name)?;
        if !self
            .by_name
            .values()
            .any(|f| f.eq_ignore_ascii_case(&filename))
        {
            self.reserved_lower.remove(&filename.to_lowercase());
        }
        Some(filename)
    }
}

/// The result of a tolerant scan of `dictionary/`.
pub struct TableScan {
    pub tables: Vec<WordTable>,
    pub files: TableFiles,
    pub warnings: Vec<QuarantineWarning>,
}

/// Scan `dictionary_dir` for table files.
///
/// Hidden files and leftover `*.tmp` temp files are skipped silently (they
/// are implementation debris, never user data). A file that exists but
/// cannot be parsed is **quarantined in place**: left on disk untouched,
/// reported in `warnings`, and its name reserved so nothing can ever be
/// written over it. One bad file never stops the rest of the workspace from
/// loading.
pub fn scan_tables_tolerant(dictionary_dir: &Path) -> Result<TableScan, StorageError> {
    let mut tables = Vec::new();
    let mut files = TableFiles::default();
    let mut warnings = Vec::new();
    if !dictionary_dir.exists() {
        return Ok(TableScan {
            tables,
            files,
            warnings,
        });
    }
    let mut entries: Vec<_> = fs::read_dir(dictionary_dir)
        .map_err(|e| io_err(dictionary_dir, e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| io_err(dictionary_dir, e))?;
    // Deterministic order, so "who wins the bare slug" never depends on the
    // filesystem's listing order.
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name.starts_with('.') || file_name.ends_with(".tmp") {
            continue;
        }
        match read_json::<WordTable>(&path) {
            Ok(mut table) => {
                table.ensure_wordname_tag();
                files.insert_existing(&table.name, file_name);
                tables.push(table);
            }
            Err(err) => {
                files.reserve_only(&file_name);
                warnings.push(QuarantineWarning {
                    file_name,
                    reason: err.to_string(),
                });
            }
        }
    }
    tables.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(TableScan {
        tables,
        files,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::storage::write_json;

    fn write(dir: &Path, filename: &str, name: &str) {
        let table = WordTable::new(name);
        write_json(&dir.join(filename), &table).unwrap();
    }

    #[test]
    fn non_ascii_names_get_distinct_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut files = TableFiles::default();
        let a = files.resolve_new("ʃáɾa");
        let b = files.resolve_new("ʔuma");
        assert_ne!(a, b);
        // Both are plain, filesystem-safe filenames.
        for name in [&a, &b] {
            assert!(!name.is_empty());
            assert!(name.chars().all(|c| c.is_ascii_graphic()));
        }
        drop(dir);
    }

    #[test]
    fn case_and_punctuation_variants_never_collide() {
        let mut files = TableFiles::default();
        let roots_upper = files.resolve_new("Roots");
        let roots_lower = files.resolve_new("roots");
        assert_ne!(roots_upper.to_lowercase(), roots_lower.to_lowercase());

        let a_b_space = files.resolve_new("a b");
        let a_b_underscore = files.resolve_new("a_b");
        assert_ne!(a_b_space.to_lowercase(), a_b_underscore.to_lowercase());
    }

    #[test]
    fn symbol_only_names_always_get_a_hash_suffix() {
        let mut files = TableFiles::default();
        let a = files.resolve_new("???");
        let b = files.resolve_new("!!!");
        assert!(a.starts_with("untitled-") && a.len() > "untitled-".len());
        assert!(b.starts_with("untitled-"));
        assert_ne!(a, b);
    }

    #[test]
    fn scan_quarantines_bad_files_without_touching_them() {
        let dir = tempfile::tempdir().unwrap();
        let dict = dir.path();
        write(dict, "verbs", "verbs");
        fs::write(dict.join("broken"), "{ not json").unwrap();
        fs::write(dict.join(".hidden"), "x").unwrap();
        fs::write(dict.join("leftover.tmp"), "x").unwrap();
        let broken_before = fs::read(dict.join("broken")).unwrap();

        let scan = scan_tables_tolerant(dict).unwrap();
        assert_eq!(scan.tables.len(), 1);
        assert_eq!(scan.tables[0].name, "verbs");
        assert_eq!(scan.warnings.len(), 1);
        assert_eq!(scan.warnings[0].file_name, "broken");
        assert_eq!(fs::read(dict.join("broken")).unwrap(), broken_before);
        assert!(
            dict.join("broken").exists(),
            "quarantine never moves the file"
        );

        // The bad file's name cannot be claimed by a new table.
        let mut files = scan.files;
        let resolved = files.resolve_new("broken");
        assert_ne!(resolved, "broken");
    }

    #[test]
    fn rename_keeps_the_same_file_remove_frees_it() {
        let mut files = TableFiles::default();
        let filename = files.resolve_new("Roots");
        files.rename("Roots", "roots");
        assert_eq!(files.filename("roots"), Some(filename.as_str()));
        assert_eq!(files.filename("Roots"), None);

        let removed = files.remove("roots").unwrap();
        assert_eq!(removed, filename);
        assert_eq!(files.filename("roots"), None);

        // The name is free again for a brand-new table.
        let reused = files.resolve_new("roots");
        assert_eq!(reused, filename);
    }
}
