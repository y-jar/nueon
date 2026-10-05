//! The dynamic dictionary model.

pub mod derivation;
mod dictionary;
mod entry;
pub mod field;
pub mod query;
mod table;
pub mod tag;
pub mod translate;

pub use derivation::{
    apply_rename, graph, parent_candidates, plan_substring_rename, DerivationNode, RelatedWord,
    RenameTarget,
};
pub use dictionary::{Dictionary, WordHit};
pub use entry::WordEntry;
pub use field::{FieldType, FieldValue};
pub use table::{TagKindChange, TagRemoval, WordTable};
pub use tag::{TagDef, DEFINITION_TAG, PARENT_TAG, WORDNAME_TAG};
pub use translate::{
    token_candidates, tokenize, translate, Candidate, SlotOutcome, Symbol, Token, TranslationReport,
};
