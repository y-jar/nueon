//! Block-level Markdown live preview.

mod parse;
mod render;
mod words;

pub(crate) use parse::parse_regions;
pub(crate) use render::render_region;
pub(crate) use words::{superscript, WordIndex};
