//! Per-conlang configuration.

mod grammar;
mod language;
mod layout;
mod morphology;
mod phonology;
mod profile;
mod settings;
mod translation;

pub use grammar::{GrammarConfig, GrammarRule};
pub use language::{LanguageConfig, TextDirection};
pub use layout::{
    GroupLayout, LayoutState, SecondaryWindow, SplitDirection, SplitLayout, TabKind, TabLayout,
    TilingLayout, WindowGeometry,
};
pub use morphology::{Feature, FeatureValue, Morphology, Paradigm, ParadigmRow, POS_TAG};
pub use phonology::{check_word, Phoneme, PhonemeKind, PhonologyConfig, Violation};
pub use profile::{Profile, PROFILE_FORMAT, PROFILE_VERSION};
pub use settings::{GridViewState, SortSpec, UiLayout, WorkspaceSettings};
pub use translation::{
    AffixKind, AffixRule, TableRole, TableRoleConfig, TranslationConfig, TranslationMode,
    TranslationOptions,
};
