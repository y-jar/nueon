//! Per-conlang configuration.

mod grammar;
mod language;
mod layout;
mod settings;
mod translation;

pub use grammar::{GrammarConfig, GrammarRule};
pub use language::{LanguageConfig, TextDirection};
pub use layout::{
    GroupLayout, LayoutState, SecondaryWindow, SplitDirection, SplitLayout, TabKind, TabLayout,
    TilingLayout, WindowGeometry,
};
pub use settings::{GridViewState, SortSpec, UiLayout, WorkspaceSettings};
pub use translation::{
    AffixKind, AffixRule, TranslationConfig, TranslationMode, TranslationOptions,
};
