//! Document export: Markdown to HTML (for PDF printing) and to ODT.
//!
//! One Markdown parser (`pulldown-cmark`) feeds both formats. ODT is a zip of
//! XML written by hand, which keeps the dependency footprint small.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use pulldown_cmark::{html, CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// Loads a local image by Markdown source: `(extension, bytes)`.
pub type ImageLoader<'a> = dyn Fn(&str) -> Option<(String, Vec<u8>)> + 'a;

/// Largest image embedded in an export.
pub const MAX_EXPORT_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// Errors raised while exporting.
#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error("failed to write the document: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to build the ODT archive: {0}")]
    Zip(#[from] zip::result::ZipError),
}

fn options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
}

/// Resolve a Markdown image `src` to a file inside the workspace.
///
/// Relative sources are taken relative to `note_dir`. Anything that is remote,
/// missing, or resolves outside `root` yields `None`, so an exported note can
/// never pull in arbitrary files from elsewhere on disk.
pub fn resolve_local(root: &Path, note_dir: &Path, src: &str) -> Option<PathBuf> {
    if src.contains("://") || src.starts_with("data:") {
        return None;
    }
    let candidate = if Path::new(src).is_absolute() {
        PathBuf::from(src)
    } else {
        note_dir.join(src)
    };
    let canonical = fs::canonicalize(candidate).ok()?;
    let root = fs::canonicalize(root).ok()?;
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return None;
    }
    if fs::metadata(&canonical).ok()?.len() > MAX_EXPORT_IMAGE_BYTES {
        return None;
    }
    Some(canonical)
}

// -- HTML --------------------------------------------------------------------

/// Render Markdown to an HTML fragment. `resolve` may rewrite image sources
/// (for example to absolute `file://` URLs); `None` keeps the original.
pub fn markdown_to_html(markdown: &str, resolve: &dyn Fn(&str) -> Option<String>) -> String {
    let parser = Parser::new_ext(markdown, options()).map(|event| match event {
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => {
            let url = resolve(&dest_url).map_or(dest_url, Into::into);
            Event::Start(Tag::Image {
                link_type,
                dest_url: url,
                title,
                id,
            })
        }
        other => other,
    });
    let mut out = String::new();
    html::push_html(&mut out, parser);
    out
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// A complete, print-styled HTML document around an HTML body fragment.
pub fn html_document(title: &str, body: &str) -> String {
    format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>{}</title><style>{}</style></head><body>{}</body></html>",
        escape_html(title),
        PRINT_CSS,
        body
    )
}

const PRINT_CSS: &str = r#"
body { font-family: system-ui, "Noto Sans", "DejaVu Sans", sans-serif; font-size: 11pt; line-height: 1.5; color: #111; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 0.4em; }
h1 { font-size: 22pt; } h2 { font-size: 17pt; } h3 { font-size: 14pt; }
p { margin: 0.5em 0; }
img { max-width: 100%; height: auto; }
code { font-family: ui-monospace, "DejaVu Sans Mono", monospace; background: #f1f1f1; padding: 0 3px; border-radius: 3px; }
pre { background: #f1f1f1; padding: 8px 10px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
pre code { background: none; padding: 0; }
blockquote { margin: 0.6em 0; padding: 0 0 0 12px; border-left: 3px solid #bbb; color: #444; }
table { border-collapse: collapse; margin: 0.6em 0; }
th, td { border: 1px solid #999; padding: 4px 8px; }
th { background: #eee; }
hr { border: none; border-top: 1px solid #999; margin: 1em 0; }
ul, ol { padding-left: 1.6em; }
li input[type=checkbox] { margin-right: 6px; }
"#;

// -- ODT ---------------------------------------------------------------------

const NS: &str = concat!(
    r#"xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" "#,
    r#"xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" "#,
    r#"xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" "#,
    r#"xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" "#,
    r#"xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" "#,
    r#"xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" "#,
    r#"xmlns:xlink="http://www.w3.org/1999/xlink" "#,
    r#"xmlns:dc="http://purl.org/dc/elements/1.1/" "#,
    r#"xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" "#,
    r#"xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0""#,
);

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Escape text for an ODT paragraph, preserving runs of spaces and tabs and
/// (when `code`) newlines.
fn escape_text(text: &str, code: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut spaces = 0usize;
    let flush = |out: &mut String, spaces: &mut usize| {
        match *spaces {
            0 => {}
            1 => out.push(' '),
            n => out.push_str(&format!("<text:s text:c=\"{n}\"/>")),
        }
        *spaces = 0;
    };
    for ch in text.chars() {
        match ch {
            ' ' => spaces += 1,
            '\t' => {
                flush(&mut out, &mut spaces);
                out.push_str("<text:tab/>");
            }
            '\n' if code => {
                flush(&mut out, &mut spaces);
                out.push_str("<text:line-break/>");
            }
            '\n' | '\r' => {
                flush(&mut out, &mut spaces);
                out.push(' ');
            }
            other => {
                flush(&mut out, &mut spaces);
                match other {
                    '&' => out.push_str("&amp;"),
                    '<' => out.push_str("&lt;"),
                    '>' => out.push_str("&gt;"),
                    c => out.push(c),
                }
            }
        }
    }
    flush(&mut out, &mut spaces);
    out
}

/// Pixel dimensions from a PNG, GIF or JPEG header.
fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() >= 24 && bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return Some((w, h));
    }
    if bytes.len() > 10 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        let w = u16::from_le_bytes(bytes[6..8].try_into().ok()?);
        let h = u16::from_le_bytes(bytes[8..10].try_into().ok()?);
        return Some((u32::from(w), u32::from(h)));
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        let mut i = 2;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xff {
                i += 1;
                continue;
            }
            let marker = bytes[i + 1];
            if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
                let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]);
                let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]);
                return Some((u32::from(w), u32::from(h)));
            }
            let len = usize::from(u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]));
            i += 2 + len.max(2);
        }
    }
    None
}

fn media_type(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

struct ImageEntry {
    name: String,
    extension: String,
    bytes: Vec<u8>,
}

struct OdtBuilder<'a> {
    body: String,
    /// Closing tag of the open paragraph/heading, if any.
    open: Option<&'static str>,
    lists: Vec<bool>,
    quote_depth: usize,
    in_code: bool,
    in_head: bool,
    underline_open: usize,
    images: Vec<ImageEntry>,
    alt: Option<(String, String)>,
    tables: usize,
    load_image: &'a ImageLoader<'a>,
}

impl<'a> OdtBuilder<'a> {
    fn paragraph_style(&self) -> &'static str {
        if self.in_code {
            "P_code"
        } else if self.in_head {
            "P_th"
        } else if self.quote_depth > 0 {
            "P_quote"
        } else {
            "P_body"
        }
    }

    fn ensure_paragraph(&mut self) {
        if self.open.is_none() {
            let style = self.paragraph_style();
            self.body
                .push_str(&format!("<text:p text:style-name=\"{style}\">"));
            self.open = Some("</text:p>");
        }
    }

    fn close_paragraph(&mut self) {
        while self.underline_open > 0 {
            self.body.push_str("</text:span>");
            self.underline_open -= 1;
        }
        if let Some(tag) = self.open.take() {
            self.body.push_str(tag);
        }
    }

    fn push_text(&mut self, text: &str) {
        if let Some((_, alt)) = self.alt.as_mut() {
            alt.push_str(text);
            return;
        }
        self.ensure_paragraph();
        let escaped = escape_text(text, self.in_code);
        self.body.push_str(&escaped);
    }

    fn span(&mut self, style: &str) {
        self.ensure_paragraph();
        self.body
            .push_str(&format!("<text:span text:style-name=\"{style}\">"));
    }

    fn image(&mut self, src: &str, alt: &str) {
        let Some((extension, bytes)) = (self.load_image)(src) else {
            self.push_text(alt);
            return;
        };
        let (width, height) = image_size(&bytes).map_or((8.0, 6.0), |(w, h)| {
            let cm = |px: u32| f64::from(px) * 2.54 / 96.0;
            let (w, h) = (cm(w.max(1)), cm(h.max(1)));
            let scale = (16.0 / w).min(1.0);
            (w * scale, h * scale)
        });
        let name = format!("img{}.{extension}", self.images.len() + 1);
        self.ensure_paragraph();
        self.body.push_str(&format!(
            "<draw:frame draw:name=\"{n}\" text:anchor-type=\"as-char\" svg:width=\"{width:.2}cm\" svg:height=\"{height:.2}cm\"><draw:image xlink:href=\"Pictures/{name}\" xlink:type=\"simple\" xlink:show=\"embed\" xlink:actuate=\"onLoad\"/></draw:frame>",
            n = escape_xml(alt),
        ));
        self.images.push(ImageEntry {
            name,
            extension,
            bytes,
        });
    }

    fn event(&mut self, event: Event<'_>) {
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(text) => self.push_text(&text),
            Event::Code(code) => {
                self.span("T_code");
                let escaped = escape_text(&code, false);
                self.body.push_str(&escaped);
                self.body.push_str("</text:span>");
            }
            Event::SoftBreak => self.push_text(" "),
            Event::HardBreak => {
                self.ensure_paragraph();
                self.body.push_str("<text:line-break/>");
            }
            Event::Rule => {
                self.close_paragraph();
                self.body.push_str("<text:p text:style-name=\"P_rule\"/>");
            }
            Event::TaskListMarker(checked) => {
                self.push_text(if checked { "\u{2611} " } else { "\u{2610} " });
            }
            Event::FootnoteReference(label) => self.push_text(&format!("[{label}]")),
            Event::InlineHtml(html) | Event::Html(html) => match html.trim() {
                "<u>" => {
                    self.span("T_underline");
                    self.underline_open += 1;
                }
                "</u>" if self.underline_open > 0 => {
                    self.body.push_str("</text:span>");
                    self.underline_open -= 1;
                }
                _ => {}
            },
            _ => {}
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => self.ensure_paragraph(),
            Tag::Heading { level, .. } => {
                self.close_paragraph();
                let n = level as usize;
                self.body.push_str(&format!(
                    "<text:h text:style-name=\"H{n}\" text:outline-level=\"{n}\">"
                ));
                self.open = Some("</text:h>");
            }
            Tag::BlockQuote(_) => {
                self.close_paragraph();
                self.quote_depth += 1;
            }
            Tag::CodeBlock(kind) => {
                self.close_paragraph();
                let _ = matches!(kind, CodeBlockKind::Fenced(_));
                self.in_code = true;
                self.ensure_paragraph();
            }
            Tag::List(first) => {
                self.close_paragraph();
                let style = if first.is_some() {
                    "L_number"
                } else {
                    "L_bullet"
                };
                self.body
                    .push_str(&format!("<text:list text:style-name=\"{style}\">"));
                self.lists.push(first.is_some());
            }
            Tag::Item => self.body.push_str("<text:list-item>"),
            Tag::Emphasis => self.span("T_italic"),
            Tag::Strong => self.span("T_bold"),
            Tag::Strikethrough => self.span("T_strike"),
            Tag::Link { dest_url, .. } => {
                self.ensure_paragraph();
                self.body.push_str(&format!(
                    "<text:a xlink:type=\"simple\" xlink:href=\"{}\">",
                    escape_xml(&dest_url)
                ));
            }
            Tag::Image { dest_url, .. } => {
                self.alt = Some((dest_url.to_string(), String::new()));
            }
            Tag::Table(columns) => {
                self.close_paragraph();
                self.tables += 1;
                self.body.push_str(&format!(
                    "<table:table table:name=\"Table{}\" table:style-name=\"Tbl\"><table:table-column table:number-columns-repeated=\"{}\"/>",
                    self.tables,
                    columns.len().max(1)
                ));
            }
            Tag::TableHead => {
                self.in_head = true;
                self.body
                    .push_str("<table:table-header-rows><table:table-row>");
            }
            Tag::TableRow => self.body.push_str("<table:table-row>"),
            Tag::TableCell => {
                self.close_paragraph();
                self.body.push_str(
                    "<table:table-cell table:style-name=\"TC\" office:value-type=\"string\">",
                );
            }
            Tag::FootnoteDefinition(label) => {
                self.close_paragraph();
                self.ensure_paragraph();
                self.push_text(&format!("[{label}] "));
            }
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::FootnoteDefinition => {
                self.close_paragraph();
            }
            TagEnd::BlockQuote(_) => {
                self.close_paragraph();
                self.quote_depth = self.quote_depth.saturating_sub(1);
            }
            TagEnd::CodeBlock => {
                self.close_paragraph();
                self.in_code = false;
            }
            TagEnd::List(_) => {
                self.close_paragraph();
                self.body.push_str("</text:list>");
                self.lists.pop();
            }
            TagEnd::Item => {
                self.close_paragraph();
                self.body.push_str("</text:list-item>");
            }
            TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => {
                self.body.push_str("</text:span>");
            }
            TagEnd::Link => self.body.push_str("</text:a>"),
            TagEnd::Image => {
                if let Some((src, alt)) = self.alt.take() {
                    self.image(&src, &alt);
                }
            }
            TagEnd::Table => self.body.push_str("</table:table>"),
            TagEnd::TableHead => {
                self.close_paragraph();
                self.in_head = false;
                self.body
                    .push_str("</table:table-row></table:table-header-rows>");
            }
            TagEnd::TableRow => self.body.push_str("</table:table-row>"),
            TagEnd::TableCell => {
                self.close_paragraph();
                self.body.push_str("</table:table-cell>");
            }
            _ => {}
        }
    }
}

fn automatic_styles() -> String {
    let mut s = String::from("<office:automatic-styles>");
    let heading = |n: usize, pt: u32| {
        format!(
            "<style:style style:name=\"H{n}\" style:family=\"paragraph\" style:default-outline-level=\"{n}\"><style:paragraph-properties fo:margin-top=\"0.4cm\" fo:margin-bottom=\"0.15cm\" fo:keep-with-next=\"always\"/><style:text-properties fo:font-size=\"{pt}pt\" fo:font-weight=\"bold\"/></style:style>"
        )
    };
    for (n, pt) in [(1, 22), (2, 18), (3, 15), (4, 13), (5, 12), (6, 11)] {
        s.push_str(&heading(n, pt));
    }
    s.push_str(concat!(
        "<style:style style:name=\"P_body\" style:family=\"paragraph\"><style:paragraph-properties fo:margin-top=\"0cm\" fo:margin-bottom=\"0.2cm\"/></style:style>",
        "<style:style style:name=\"P_code\" style:family=\"paragraph\"><style:paragraph-properties fo:background-color=\"#f1f1f1\" fo:padding=\"0.1cm\" fo:margin-bottom=\"0.2cm\"/><style:text-properties fo:font-family=\"Liberation Mono\" style:font-name=\"Liberation Mono\" fo:font-size=\"10pt\"/></style:style>",
        "<style:style style:name=\"P_quote\" style:family=\"paragraph\"><style:paragraph-properties fo:margin-left=\"1cm\" fo:margin-bottom=\"0.2cm\" fo:border-left=\"1.5pt solid #bbbbbb\" fo:padding-left=\"0.3cm\"/><style:text-properties fo:color=\"#444444\"/></style:style>",
        "<style:style style:name=\"P_rule\" style:family=\"paragraph\"><style:paragraph-properties fo:margin-top=\"0.2cm\" fo:margin-bottom=\"0.2cm\" fo:border-bottom=\"0.5pt solid #999999\" fo:padding=\"0cm\"/></style:style>",
        "<style:style style:name=\"P_th\" style:family=\"paragraph\"><style:text-properties fo:font-weight=\"bold\"/></style:style>",
        "<style:style style:name=\"T_bold\" style:family=\"text\"><style:text-properties fo:font-weight=\"bold\"/></style:style>",
        "<style:style style:name=\"T_italic\" style:family=\"text\"><style:text-properties fo:font-style=\"italic\"/></style:style>",
        "<style:style style:name=\"T_underline\" style:family=\"text\"><style:text-properties style:text-underline-style=\"solid\" style:text-underline-width=\"auto\" style:text-underline-color=\"font-color\"/></style:style>",
        "<style:style style:name=\"T_strike\" style:family=\"text\"><style:text-properties style:text-line-through-style=\"solid\"/></style:style>",
        "<style:style style:name=\"T_code\" style:family=\"text\"><style:text-properties fo:font-family=\"Liberation Mono\" style:font-name=\"Liberation Mono\" fo:background-color=\"#f1f1f1\"/></style:style>",
        "<style:style style:name=\"Tbl\" style:family=\"table\"><style:table-properties style:width=\"17cm\" table:align=\"margins\"/></style:style>",
        "<style:style style:name=\"TC\" style:family=\"table-cell\"><style:table-cell-properties fo:border=\"0.5pt solid #999999\" fo:padding=\"0.1cm\"/></style:style>",
    ));
    for (name, number) in [("L_bullet", false), ("L_number", true)] {
        s.push_str(&format!("<text:list-style style:name=\"{name}\">"));
        for level in 1..=6u32 {
            let indent = f64::from(level) * 0.8;
            let props = format!(
                "<style:list-level-properties text:list-level-position-and-space-mode=\"label-alignment\"><style:list-level-label-alignment text:label-followed-by=\"listtab\" text:list-tab-stop-position=\"{indent:.1}cm\" fo:text-indent=\"-0.6cm\" fo:margin-left=\"{indent:.1}cm\"/></style:list-level-properties>"
            );
            if number {
                s.push_str(&format!(
                    "<text:list-level-style-number text:level=\"{level}\" style:num-suffix=\".\" style:num-format=\"1\">{props}</text:list-level-style-number>"
                ));
            } else {
                s.push_str(&format!(
                    "<text:list-level-style-bullet text:level=\"{level}\" text:bullet-char=\"\u{2022}\">{props}</text:list-level-style-bullet>"
                ));
            }
        }
        s.push_str("</text:list-style>");
    }
    s.push_str("</office:automatic-styles>");
    s
}

/// Convert Markdown to an ODT file's bytes. `load_image` returns
/// `(extension, bytes)` for a local image source, or `None` to fall back to the
/// image's alt text.
pub fn markdown_to_odt(
    markdown: &str,
    title: &str,
    load_image: &ImageLoader<'_>,
) -> Result<Vec<u8>, ExportError> {
    let mut builder = OdtBuilder {
        body: String::new(),
        open: None,
        lists: Vec::new(),
        quote_depth: 0,
        in_code: false,
        in_head: false,
        underline_open: 0,
        images: Vec::new(),
        alt: None,
        tables: 0,
        load_image,
    };
    for event in Parser::new_ext(markdown, options()) {
        builder.event(event);
    }
    builder.close_paragraph();

    let content = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<office:document-content {NS} office:version=\"1.2\">{styles}<office:body><office:text>{body}</office:text></office:body></office:document-content>",
        styles = automatic_styles(),
        body = builder.body,
    );
    let styles = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<office:document-styles {NS} office:version=\"1.2\"><office:styles><style:default-style style:family=\"paragraph\"><style:text-properties fo:font-size=\"11pt\"/></style:default-style></office:styles></office:document-styles>"
    );
    let meta = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<office:document-meta {NS} office:version=\"1.2\"><office:meta><dc:title>{}</dc:title><meta:generator>nueon</meta:generator></office:meta></office:document-meta>",
        escape_xml(title)
    );
    let mut manifest = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<manifest:manifest xmlns:manifest=\"urn:oasis:names:tc:opendocument:xmlns:manifest:1.0\" manifest:version=\"1.2\"><manifest:file-entry manifest:full-path=\"/\" manifest:media-type=\"application/vnd.oasis.opendocument.text\"/><manifest:file-entry manifest:full-path=\"content.xml\" manifest:media-type=\"text/xml\"/><manifest:file-entry manifest:full-path=\"styles.xml\" manifest:media-type=\"text/xml\"/><manifest:file-entry manifest:full-path=\"meta.xml\" manifest:media-type=\"text/xml\"/>",
    );
    for image in &builder.images {
        manifest.push_str(&format!(
            "<manifest:file-entry manifest:full-path=\"Pictures/{}\" manifest:media-type=\"{}\"/>",
            image.name,
            media_type(&image.extension)
        ));
    }
    manifest.push_str("</manifest:manifest>");

    let mut buffer = std::io::Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buffer);
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        // The mimetype entry must come first and be stored uncompressed.
        zip.start_file("mimetype", stored)?;
        zip.write_all(b"application/vnd.oasis.opendocument.text")?;
        zip.start_file("META-INF/manifest.xml", deflated)?;
        zip.write_all(manifest.as_bytes())?;
        zip.start_file("content.xml", deflated)?;
        zip.write_all(content.as_bytes())?;
        zip.start_file("styles.xml", deflated)?;
        zip.write_all(styles.as_bytes())?;
        zip.start_file("meta.xml", deflated)?;
        zip.write_all(meta.as_bytes())?;
        for image in &builder.images {
            zip.start_file(format!("Pictures/{}", image.name), stored)?;
            zip.write_all(&image.bytes)?;
        }
        zip.finish()?;
    }
    Ok(buffer.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    const PNG_1X1: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, b'I', b'H', b'D', b'R', 0,
        0, 0, 2, 0, 0, 0, 3,
    ];

    fn unzip(bytes: Vec<u8>) -> zip::ZipArchive<std::io::Cursor<Vec<u8>>> {
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap()
    }

    fn read(archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>, name: &str) -> String {
        let mut text = String::new();
        archive
            .by_name(name)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        text
    }

    #[test]
    fn html_rewrites_images_and_keeps_formatting() {
        let html = markdown_to_html(
            "# T\n\n**b** <u>u</u>\n\n![a](../assets/x.png)\n\n| h |\n|---|\n| c |",
            &|src| src.starts_with("../").then(|| format!("file:///ws/{src}")),
        );
        assert!(html.contains("<h1>T</h1>"));
        assert!(html.contains("<strong>b</strong>"));
        assert!(html.contains("<u>u</u>"));
        assert!(html.contains("src=\"file:///ws/../assets/x.png\""));
        assert!(html.contains("<table>"));
        assert!(html_document("A & B", &html).contains("<title>A &amp; B</title>"));
    }

    #[test]
    fn odt_is_a_valid_package_with_content() {
        let markdown = "# Title\n\nHello **bold** *it* <u>under</u> `code` [site](https://x.org) & <tag>\n\n- one\n- two\n  - nested\n\n1. first\n\n- [x] done\n\n> quote\n\n```\nlet  x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n![pic](p.png)\n";
        let bytes = markdown_to_odt(markdown, "Doc <1>", &|src| {
            (src == "p.png").then(|| ("png".to_string(), PNG_1X1.to_vec()))
        })
        .unwrap();

        let mut archive = unzip(bytes);
        assert_eq!(archive.by_index(0).unwrap().name(), "mimetype");
        assert_eq!(
            archive.by_index(0).unwrap().compression(),
            CompressionMethod::Stored
        );
        assert_eq!(
            read(&mut archive, "mimetype"),
            "application/vnd.oasis.opendocument.text"
        );

        let content = read(&mut archive, "content.xml");
        assert!(content
            .contains("<text:h text:style-name=\"H1\" text:outline-level=\"1\">Title</text:h>"));
        assert!(content.contains("T_bold\">bold</text:span>"));
        assert!(content.contains("T_italic\">it</text:span>"));
        assert!(content.contains("T_underline\">under</text:span>"));
        assert!(content.contains("T_code\">code</text:span>"));
        assert!(content.contains("xlink:href=\"https://x.org\""));
        assert!(content.contains("&amp; &lt;tag&gt;") || content.contains("&amp; "));
        assert!(content.contains("<text:list text:style-name=\"L_bullet\">"));
        assert!(content.contains("<text:list text:style-name=\"L_number\">"));
        assert!(
            content.matches("<text:list ").count() >= 4,
            "nested list present"
        );
        assert!(content.contains("\u{2611} done"));
        assert!(content.contains("P_quote"));
        assert!(content.contains("let<text:s text:c=\"2\"/>x = 1;"));
        assert!(content.contains("<table:table "));
        assert!(content.contains("table:table-header-rows"));
        assert!(content.contains("P_rule"));
        assert!(content.contains("Pictures/img1.png"));
        // 2x3 px at 96 dpi.
        assert!(content.contains("svg:width=\"0.05cm\""));

        let manifest = read(&mut archive, "META-INF/manifest.xml");
        assert!(manifest.contains("Pictures/img1.png"));
        assert!(read(&mut archive, "meta.xml").contains("Doc &lt;1&gt;"));
        assert!(archive.by_name("Pictures/img1.png").is_ok());
    }

    #[test]
    fn missing_images_fall_back_to_alt_text() {
        let bytes = markdown_to_odt("![fallback](nope.png)", "t", &|_| None).unwrap();
        let mut archive = unzip(bytes);
        assert!(read(&mut archive, "content.xml").contains("fallback"));
        assert!(archive.by_name("Pictures/img1.png").is_err());
    }

    #[test]
    fn local_image_resolution_stays_inside_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        fs::create_dir_all(root.join("notes/sub")).unwrap();
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(root.join("assets/a.png"), PNG_1X1).unwrap();
        fs::write(dir.path().join("secret.png"), PNG_1X1).unwrap();
        let note_dir = root.join("notes/sub");

        assert!(resolve_local(&root, &note_dir, "../../assets/a.png").is_some());
        assert!(resolve_local(&root, &note_dir, "../../../secret.png").is_none());
        assert!(resolve_local(&root, &note_dir, "https://x/y.png").is_none());
        let outside = dir.path().join("secret.png");
        assert!(resolve_local(&root, &note_dir, outside.to_str().unwrap()).is_none());
        assert!(resolve_local(&root, &note_dir, "missing.png").is_none());
    }

    #[test]
    fn image_sizes_are_read_from_headers() {
        assert_eq!(image_size(PNG_1X1), Some((2, 3)));
        assert_eq!(image_size(b"GIF89a\x04\x00\x05\x00....."), Some((4, 5)));
        assert_eq!(image_size(b"not an image"), None);
    }
}
