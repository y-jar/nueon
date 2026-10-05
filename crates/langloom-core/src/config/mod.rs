//! Per-conlang configuration.

mod grammar;
mod language;
mod settings;
mod translation;

pub use grammar::{GrammarConfig, GrammarRule};
pub use language::{LanguageConfig, TextDirection};
pub use settings::{GridViewState, SortSpec, WorkspaceSettings};
pub use translation::{AffixKind, AffixRule, TranslationConfig, TranslationOptions};
