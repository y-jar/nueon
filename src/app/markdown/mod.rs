//! Block-level Markdown live preview.

mod parse;
mod render;

pub(crate) use parse::parse_regions;
pub(crate) use render::render_region;
