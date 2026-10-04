//! Dynamic field types and values.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The data type of a [`super::TagDef`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    #[default]
    Text,
    Boolean,
    TagList,
    /// A pointer to another word's UUID.
    Reference,
    /// A list of pointers to other words' UUIDs (used by `parent`).
    References,
}

/// The actual data stored for a tag on a [`super::WordEntry`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum FieldValue {
    Text(String),
    Boolean(bool),
    TagList(Vec<String>),
    Reference(Uuid),
    References(Vec<Uuid>),
}

impl FieldValue {
    /// The schema type this value corresponds to.
    pub fn field_type(&self) -> FieldType {
        match self {
            FieldValue::Text(_) => FieldType::Text,
            FieldValue::Boolean(_) => FieldType::Boolean,
            FieldValue::TagList(_) => FieldType::TagList,
            FieldValue::Reference(_) => FieldType::Reference,
            FieldValue::References(_) => FieldType::References,
        }
    }

    /// Whether this value matches the expected type of a tag.
    pub fn matches(&self, expected: FieldType) -> bool {
        self.field_type() == expected
    }
}
