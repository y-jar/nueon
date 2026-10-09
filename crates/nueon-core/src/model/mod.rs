//! The dynamic dictionary model.

pub mod derivation;
mod dictionary;
mod entry;
pub mod field;
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
pub use tag::{TagDef, TagFormat, DEFINITION_TAG, PARENT_TAG, WORDNAME_TAG};
pub use translate::{
    compose, inflect, paradigm_grid, tokenize, translate, ComposePiece, GlossMorpheme, GridCell,
    GridRow, Inflection, InflectionKind, InflectionMorpheme, InterlinearGloss, Morpheme,
    ParadigmGrid, SlotOutcome, Symbol, Token, TranslationReport,
};
