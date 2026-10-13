//! TrueType font compilation for the writing system.

mod compile;
mod outline;

pub use compile::{compile_font, read_back, FontCheck, FontGlyph, FontReport, FontSettings};
pub use outline::{contours_to_bezpaths, glyph_from_contours, FontError};
