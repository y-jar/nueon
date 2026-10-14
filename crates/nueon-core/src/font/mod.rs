//! TrueType font compilation for the writing system.

mod compile;
mod layout;
mod outline;
mod validate;

pub use compile::{compile_font, read_back, FontCheck, FontGlyph, FontReport, FontSettings};
pub use layout::{plan_layout, Layout, FEATURE, SPACE_ADVANCE};
pub use outline::{contours_to_bezpaths, glyph_from_contours, FontError};
pub use validate::{
    blocks_export, needs_reversal, normalise_winding, reverse_contour, self_intersects,
    validate_glyphs, FontIssue, Severity,
};
