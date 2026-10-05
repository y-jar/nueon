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

    /// Convert this value to another field type, if the conversion is
    /// meaningful. Returns `None` when the data cannot be represented in the
    /// target type (callers may then drop the value).
    pub fn coerce_to(&self, target: FieldType) -> Option<FieldValue> {
        if self.field_type() == target {
            return Some(self.clone());
        }

        fn text_of(value: &FieldValue) -> String {
            match value {
                FieldValue::Text(text) => text.clone(),
                FieldValue::Boolean(flag) => flag.to_string(),
                FieldValue::TagList(list) => list.join(", "),
                FieldValue::Reference(id) => id.to_string(),
                FieldValue::References(ids) => ids
                    .iter()
                    .map(Uuid::to_string)
                    .collect::<Vec<_>>()
                    .join(", "),
            }
        }

        fn list_of(value: &FieldValue) -> Vec<String> {
            match value {
                FieldValue::Text(text) if !text.trim().is_empty() => vec![text.clone()],
                FieldValue::Text(_) => Vec::new(),
                FieldValue::Boolean(flag) => vec![flag.to_string()],
                FieldValue::TagList(list) => list.clone(),
                FieldValue::Reference(id) => vec![id.to_string()],
                FieldValue::References(ids) => ids.iter().map(Uuid::to_string).collect(),
            }
        }

        fn uuids_of(value: &FieldValue) -> Vec<Uuid> {
            match value {
                FieldValue::Text(text) => text
                    .split(',')
                    .filter_map(|part| Uuid::parse_str(part.trim()).ok())
                    .collect(),
                FieldValue::TagList(list) => list
                    .iter()
                    .filter_map(|part| Uuid::parse_str(part.trim()).ok())
                    .collect(),
                FieldValue::Reference(id) => vec![*id],
                FieldValue::References(ids) => ids.clone(),
                FieldValue::Boolean(_) => Vec::new(),
            }
        }

        match target {
            FieldType::Text => Some(FieldValue::Text(text_of(self))),
            FieldType::Boolean => Some(FieldValue::Boolean(match self {
                FieldValue::Text(text) => {
                    let trimmed = text.trim();
                    !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("false")
                }
                FieldValue::TagList(list) => !list.is_empty(),
                FieldValue::Boolean(flag) => *flag,
                FieldValue::Reference(_) | FieldValue::References(_) => true,
            })),
            FieldType::TagList => {
                let list = list_of(self);
                if list.is_empty() {
                    None
                } else {
                    Some(FieldValue::TagList(list))
                }
            }
            FieldType::Reference => uuids_of(self).into_iter().next().map(FieldValue::Reference),
            FieldType::References => {
                let ids = uuids_of(self);
                if ids.is_empty() {
                    None
                } else {
                    Some(FieldValue::References(ids))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_and_boolean_convert_both_ways() {
        assert_eq!(
            FieldValue::Text("yes".into()).coerce_to(FieldType::Boolean),
            Some(FieldValue::Boolean(true))
        );
        assert_eq!(
            FieldValue::Text("false".into()).coerce_to(FieldType::Boolean),
            Some(FieldValue::Boolean(false))
        );
        assert_eq!(
            FieldValue::Boolean(false).coerce_to(FieldType::Text),
            Some(FieldValue::Text("false".into()))
        );
    }

    #[test]
    fn tag_list_stringifies_and_parses_references() {
        let list = FieldValue::TagList(vec!["a".into(), "b".into()]);
        assert_eq!(
            list.coerce_to(FieldType::Text),
            Some(FieldValue::Text("a, b".into()))
        );

        let id = Uuid::new_v4();
        let as_list = FieldValue::Reference(id).coerce_to(FieldType::TagList);
        assert_eq!(as_list, Some(FieldValue::TagList(vec![id.to_string()])));
    }

    #[test]
    fn reference_requires_a_parseable_uuid() {
        assert_eq!(
            FieldValue::Text("not-a-uuid".into()).coerce_to(FieldType::Reference),
            None
        );
        let id = Uuid::new_v4();
        assert_eq!(
            FieldValue::Text(id.to_string()).coerce_to(FieldType::Reference),
            Some(FieldValue::Reference(id))
        );
    }
}
