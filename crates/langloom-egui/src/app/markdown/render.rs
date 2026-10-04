//! Egui rendering for Markdown regions.

use egui::text::{LayoutJob, TextFormat};
use egui::{Color32, FontId, Label, RichText, Sense, TextWrapMode, Ui};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use uuid::Uuid;

use super::parse::{fence_marker, Region, RegionKind};
use super::words::{superscript, WordIndex};

const STRONG: Color32 = Color32::from_rgb(240, 232, 216);
const WEAK: Color32 = Color32::from_rgb(158, 148, 132);
const ACCENT: Color32 = Color32::from_rgb(196, 148, 92);

/// The result of interacting with one region.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct RegionAction {
    /// A plain click requesting raw edit mode.
    pub edit: bool,
    /// A Ctrl+click on a dictionary word requesting inspection.
    pub inspect: Option<Uuid>,
}

impl RegionAction {
    fn merge(&mut self, other: RegionAction) {
        self.edit |= other.edit;
        if self.inspect.is_none() {
            self.inspect = other.inspect;
        }
    }
}

/// Render one region. Returns the interaction outcome.
pub(crate) fn render_region(
    ui: &mut Ui,
    text: &str,
    region: &Region,
    words: &WordIndex,
) -> RegionAction {
    let content = &text[region.content.clone()];
    match &region.kind {
        RegionKind::Blank => {
            let (_rect, response) =
                ui.allocate_exact_size(egui::vec2(ui.available_width(), 10.0), Sense::click());
            RegionAction {
                edit: response.clicked(),
                inspect: None,
            }
        }
        RegionKind::Rule => {
            ui.separator();
            RegionAction::default()
        }
        RegionKind::Heading(level) => {
            let body = strip_heading(content);
            let style = Style::heading(heading_size(*level));
            render_lines(ui, body, style, words)
        }
        RegionKind::Paragraph => {
            let style = Style::body(ui.visuals().text_color());
            render_lines(ui, content, style, words)
        }
        RegionKind::ListItem { ordered, marker } => {
            let body = strip_list_marker(content);
            let bullet = if *ordered {
                marker.clone()
            } else {
                "•".to_string()
            };
            let inner = ui.horizontal_wrapped(|ui| {
                ui.spacing_mut().item_spacing.x = 0.0;
                let mut action = RegionAction::default();
                let bullet_response = ui.add(
                    Label::new(RichText::new(format!("{bullet} ")).strong().color(STRONG))
                        .sense(Sense::click()),
                );
                if bullet_response.clicked() {
                    action.edit = true;
                }
                action.merge(render_inline(
                    ui,
                    body,
                    Style::body(ui.visuals().text_color()),
                    words,
                ));
                action
            });
            inner.inner
        }
        RegionKind::BlockQuote => {
            let body = strip_blockquote(content);
            let mut action = RegionAction::default();
            for line in body.split('\n') {
                let inner = ui.horizontal_wrapped(|ui| {
                    ui.spacing_mut().item_spacing.x = 0.0;
                    ui.colored_label(ACCENT, "▎ ");
                    render_inline(ui, line, Style::quote(), words)
                });
                action.merge(inner.inner);
            }
            action
        }
        RegionKind::CodeBlock { lang } => {
            let body = strip_code_fences(content);
            let job = monospace_job(ui, &body);
            let edit = egui::Frame::NONE
                .fill(ui.visuals().code_bg_color)
                .inner_margin(6.0)
                .corner_radius(4.0)
                .show(ui, |ui| {
                    if !lang.is_empty() {
                        ui.label(RichText::new(lang).small().color(WEAK));
                    }
                    clickable(ui, job)
                })
                .inner;
            RegionAction {
                edit,
                inspect: None,
            }
        }
    }
}

fn render_lines(ui: &mut Ui, text: &str, style: Style, words: &WordIndex) -> RegionAction {
    let mut action = RegionAction::default();
    for line in text.split('\n') {
        let inner = ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing.x = 0.0;
            render_inline(ui, line, style.clone(), words)
        });
        action.merge(inner.inner);
    }
    action
}

#[derive(Clone)]
struct Style {
    size: f32,
    color: Color32,
    italics: bool,
    code: bool,
    link: bool,
}

impl Style {
    fn body(color: Color32) -> Self {
        Self {
            size: 15.0,
            color,
            italics: false,
            code: false,
            link: false,
        }
    }

    fn heading(size: f32) -> Self {
        Self {
            size,
            color: STRONG,
            italics: false,
            code: false,
            link: false,
        }
    }

    fn quote() -> Self {
        Self {
            size: 15.0,
            color: WEAK,
            italics: false,
            code: false,
            link: false,
        }
    }

    fn rich(&self, text: &str) -> RichText {
        let mut rich = RichText::new(text).size(self.size).color(self.color);
        if self.italics {
            rich = rich.italics();
        }
        if self.code {
            rich = rich.monospace();
        }
        if self.link {
            rich = rich.underline();
        }
        rich
    }
}

fn render_inline(ui: &mut Ui, text: &str, style: Style, words: &WordIndex) -> RegionAction {
    let mut action = RegionAction::default();
    let mut emphasis = 0usize;
    let mut strong = 0usize;
    let mut link = false;
    let mut link_url: Option<String> = None;

    for event in Parser::new_ext(text, Options::empty()) {
        match event {
            Event::Start(Tag::Emphasis) => emphasis += 1,
            Event::End(TagEnd::Emphasis) => emphasis = emphasis.saturating_sub(1),
            Event::Start(Tag::Strong) => strong += 1,
            Event::End(TagEnd::Strong) => strong = strong.saturating_sub(1),
            Event::Start(Tag::Link { dest_url, .. }) => {
                link = true;
                link_url = Some(dest_url.to_string());
            }
            Event::End(TagEnd::Link) => {
                link = false;
                link_url = None;
            }
            Event::Text(value) => {
                let mut current = style.clone();
                current.italics = emphasis > 0;
                if strong > 0 {
                    current.color = STRONG;
                }
                if link {
                    current.color = ui.visuals().hyperlink_color;
                    current.link = true;
                }
                for (segment, word_like) in split_segments(&value) {
                    action.merge(render_segment(
                        ui,
                        segment,
                        &current,
                        words,
                        word_like,
                        link_url.as_deref(),
                    ));
                }
            }
            Event::Code(value) => {
                let mut current = style.clone();
                current.code = true;
                action.merge(render_segment(ui, &value, &current, words, false, None));
            }
            Event::SoftBreak | Event::HardBreak => {
                action.merge(render_segment(ui, " ", &style, words, false, None));
            }
            _ => {}
        }
    }

    action
}

fn render_segment(
    ui: &mut Ui,
    text: &str,
    style: &Style,
    words: &WordIndex,
    word_like: bool,
    url: Option<&str>,
) -> RegionAction {
    if text.is_empty() {
        return RegionAction::default();
    }

    if let Some(url) = url {
        let response = ui
            .add(Label::new(style.rich(text)).sense(Sense::click()))
            .on_hover_text(url);
        if response.clicked() {
            ui.ctx().open_url(egui::OpenUrl::new_tab(url));
        }
        return RegionAction::default();
    }

    if word_like {
        if let Some(hits) = words.hits(text) {
            let hit = &hits[0];
            let label = if hits.len() > 1 {
                format!("{text}{}", superscript(1))
            } else {
                text.to_string()
            };
            let response = ui
                .add(Label::new(style.rich(&label).color(ACCENT)).sense(Sense::click()))
                .on_hover_text(&hit.tooltip);
            if response.clicked() {
                return if ctrl_held(ui) {
                    RegionAction {
                        edit: false,
                        inspect: Some(hit.id),
                    }
                } else {
                    RegionAction {
                        edit: true,
                        inspect: None,
                    }
                };
            }
            return RegionAction::default();
        }
    }

    let response = ui.add(Label::new(style.rich(text)).sense(Sense::click()));
    RegionAction {
        edit: response.clicked(),
        inspect: None,
    }
}

fn ctrl_held(ui: &Ui) -> bool {
    ui.input(|input| input.modifiers.ctrl || input.modifiers.command)
}

fn split_segments(text: &str) -> Vec<(&str, bool)> {
    let mut segments = Vec::new();
    let mut start = 0;
    let mut word = None;
    for (index, character) in text.char_indices() {
        let is_word = is_word_char(character);
        match word {
            None => word = Some(is_word),
            Some(previous) if previous != is_word => {
                segments.push((&text[start..index], previous));
                start = index;
                word = Some(is_word);
            }
            _ => {}
        }
    }
    if let Some(is_word) = word {
        if start < text.len() {
            segments.push((&text[start..], is_word));
        }
    }
    segments
}

fn is_word_char(character: char) -> bool {
    character.is_alphanumeric() || matches!(character, '-' | '\'' | '\u{2019}')
}

fn clickable(ui: &mut Ui, job: LayoutJob) -> bool {
    ui.add(
        Label::new(job)
            .wrap_mode(TextWrapMode::Extend)
            .sense(Sense::click()),
    )
    .clicked()
}

fn heading_size(level: u8) -> f32 {
    match level {
        1 => 28.0,
        2 => 24.0,
        3 => 20.0,
        4 => 18.0,
        5 => 16.0,
        _ => 15.0,
    }
}

fn monospace_job(ui: &Ui, text: &str) -> LayoutJob {
    let mut job = LayoutJob::default();
    job.wrap.max_width = f32::INFINITY;
    job.break_on_newline = true;
    job.append(
        text,
        0.0,
        TextFormat::simple(FontId::monospace(14.0), ui.visuals().text_color()),
    );
    job
}

fn strip_heading(text: &str) -> &str {
    let trimmed = text.trim_start();
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    trimmed[hashes..].trim_start_matches(' ').trim_end()
}

fn strip_list_marker(text: &str) -> &str {
    let trimmed = text.trim_start();
    let end = match trimmed.chars().next() {
        Some(first) if matches!(first, '-' | '*' | '+') => first.len_utf8(),
        Some(first) if first.is_ascii_digit() => {
            let digits_end = trimmed
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(trimmed.len());
            if trimmed[digits_end..].starts_with('.') || trimmed[digits_end..].starts_with(')') {
                digits_end + 1
            } else {
                digits_end
            }
        }
        _ => 0,
    };
    trimmed[end..].trim_start_matches(' ').trim_end()
}

fn strip_blockquote(text: &str) -> String {
    text.lines()
        .map(|line| {
            let trimmed = line.trim_start();
            let without = trimmed.strip_prefix('>').unwrap_or(trimmed);
            without.strip_prefix(' ').unwrap_or(without).trim_end()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn strip_code_fences(text: &str) -> String {
    let mut lines: Vec<&str> = text.lines().collect();
    if lines
        .first()
        .is_some_and(|line| fence_marker(line.trim_start()).is_some())
    {
        lines.remove(0);
    }
    if lines
        .last()
        .is_some_and(|line| fence_marker(line.trim_start()).is_some())
    {
        lines.pop();
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_markers() {
        assert_eq!(strip_heading("## Title"), "Title");
        assert_eq!(strip_list_marker("- item"), "item");
        assert_eq!(strip_list_marker("3. item"), "item");
        assert_eq!(strip_blockquote("> a\n> b"), "a\nb");
        assert_eq!(strip_code_fences("```rust\nx\n```"), "x");
    }

    #[test]
    fn splits_words_and_separators() {
        assert_eq!(
            split_segments("kala, velo!"),
            vec![("kala", true), (", ", false), ("velo", true), ("!", false)]
        );
        assert_eq!(split_segments("a-b"), vec![("a-b", true)]);
        assert!(split_segments("").is_empty());
    }
}
