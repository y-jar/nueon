//! A table's tag (column) definition.

use serde::{Deserialize, Serialize};

use super::field::FieldType;

/// The built-in starting tag present on every word and every table.
pub const WORDNAME_TAG: &str = "wordname";
/// Reserved optional tag holding English definition senses (misspell-guarded).
pub const DEFINITION_TAG: &str = "definition";
/// Reserved optional tag linking a word to its root/parent word.
pub const PARENT_TAG: &str = "parent";

/// The expected type for a reserved tag name, if it is reserved.
pub fn reserved_kind(name: &str) -> Option<FieldType> {
    match name {
        WORDNAME_TAG => Some(FieldType::Text),
        DEFINITION_TAG => Some(FieldType::TagList),
        PARENT_TAG => Some(FieldType::Reference),
        _ => None,
    }
}

/// Whether a tag name is reserved by the application.
pub fn is_reserved(name: &str) -> bool {
    reserved_kind(name).is_some()
}

/// A tag is a column in a table's database view. Tags are scoped per table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TagDef {
    /// Column name, e.g. `wordname`, `part of speech`.
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// The value type stored under this tag.
    pub kind: FieldType,
    /// Whether the app owns this tag (e.g. `wordname`), preventing removal.
    #[serde(default)]
    pub builtin: bool,
}

impl TagDef {
    /// A user-defined tag. Reserved names are normalized to their fixed type.
    pub fn new(name: impl Into<String>, kind: FieldType) -> Self {
        let name = name.into();
        let kind = reserved_kind(&name).unwrap_or(kind);
        Self {
            builtin: name == WORDNAME_TAG,
            name,
            description: String::new(),
            color: None,
            kind,
        }
    }

    /// The built-in `wordname` tag.
    pub fn wordname() -> Self {
        Self {
            name: WORDNAME_TAG.to_string(),
            description: "The base conlang spelling.".to_string(),
            color: None,
            kind: FieldType::Text,
            builtin: true,
        }
    }

    /// Whether this tag is reserved by the application.
    pub fn is_reserved(&self) -> bool {
        is_reserved(&self.name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_names_get_fixed_types() {
        let parent = TagDef::new("parent", FieldType::Text);
        assert_eq!(parent.kind, FieldType::Reference);

        let definition = TagDef::new("definition", FieldType::Text);
        assert_eq!(definition.kind, FieldType::TagList);

        let custom = TagDef::new("part of speech", FieldType::TagList);
        assert_eq!(custom.kind, FieldType::TagList);
        assert!(!custom.is_reserved());
    }

    #[test]
    fn wordname_is_builtin() {
        assert!(TagDef::wordname().builtin);
        assert!(TagDef::new(WORDNAME_TAG, FieldType::Text).builtin);
    }
}
