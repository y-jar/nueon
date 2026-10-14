//! Per-conlang configuration.

mod grammar;
mod language;
mod layout;
mod morphology;
mod phonology;
mod profile;
mod settings;
mod translation;
mod writing_system;

pub use grammar::{GrammarConfig, GrammarRule};
pub use language::{LanguageConfig, TextDirection};
pub use layout::{
    GroupLayout, LayoutState, SecondaryWindow, SplitDirection, SplitLayout, TabKind, TabLayout,
    TilingLayout, WindowGeometry,
};
pub use morphology::{
    Feature, FeatureColumn, FeatureValue, MorphemeRef, Morphology, Paradigm, ParadigmRow, POS_TAG,
};
pub use phonology::{
    apply_rules, apply_to_word, check_word, segments, Phoneme, PhonemeKind, PhonologyConfig,
    Segment, SoundChangeRule, Violation,
};
pub use profile::{Profile, PROFILE_FORMAT, PROFILE_VERSION};
pub use settings::{GridViewState, SortSpec, UiLayout, WorkspaceSettings};
pub use translation::{
    AffixKind, AffixRule, TableRole, TableRoleConfig, TranslationConfig, TranslationMode,
    TranslationOptions,
};
pub use writing_system::{
    parse_svg_path, path_data, svg_path_data, to_svg_document, to_svg_symbol, transform_contour,
    validate_components, validate_outline, ComponentInstance, Contour, FillRule, GlyphForms,
    GlyphMeta, GlyphOutline, Node, NodeKind, OrthographyRule, OutlineElement, WritingConfig,
    WritingDirection,
};
