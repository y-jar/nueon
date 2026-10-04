//! Egui rendering for Markdown regions.

use egui::text::{LayoutJob, TextFormat};
use egui::{Color32, FontId, Label, Sense, Stroke, TextWrapMode, Ui};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

use super::parse::{fence_marker, Region, RegionKind};

const STRONG: Color32 = Color32::from_rgb(240, 232, 216);
const WEAK: Color32 = Color32::from_rgb(158, 148, 132);
const ACCENT: Color32 = Color32::from_rgb(196, 148, 92);

/// Render one region. Returns `true` if the user clicked it.
pub(crate) fn render_region(ui: &mut Ui, text: &str, region: &Region) -> bool {
    let content = &text[region.content.clone()];
    match &region.kind {
        RegionKind::Blank => {
            let (_rect, response) =
                ui.allocate_exact_size(egui::vec2(ui.available_width(), 10.0), Sense::click());
            response.clicked()
        }
        RegionKind::Rule => {
            ui.separator();
            false
        }
        RegionKind::Heading(level) => {
            let body = strip_heading(content);
            let job = inline_job(
                ui,
                body,
                FontId::proportional(heading_size(*level)),
                STRONG,
                true,
            );
            clickable(ui, job, TextWrapMode::Wrap)
        }
        RegionKind::Paragraph => {
            let job = inline_job(ui, content, body_font(), ui.visuals().text_color(), false);
            clickable(ui, job, TextWrapMode::Wrap)
        }
        RegionKind::ListItem { ordered, marker } => {
            let body = strip_list_marker(content);
            let mut clicked = false;
            ui.horizontal_wrapped(|ui| {
                let bullet = if *ordered {
                    marker.clone()
                } else {
                    "•".to_string()
                };
                ui.label(egui::RichText::new(bullet).strong().color(STRONG));
                let job = inline_job(ui, body, body_font(), ui.visuals().text_color(), false);
                clicked = clickable(ui, job, TextWrapMode::Wrap);
            });
            clicked
        }
        RegionKind::BlockQuote => {
            let body = strip_blockquote(content);
            let mut clicked = false;
            ui.horizontal(|ui| {
                ui.colored_label(ACCENT, "▎");
                let job = inline_job(ui, &body, body_font(), WEAK, false);
                clicked = clickable(ui, job, TextWrapMode::Wrap);
            });
            clicked
        }
        RegionKind::CodeBlock { lang } => {
            let body = strip_code_fences(content);
            let job = monospace_job(ui, &body);
            egui::Frame::NONE
                .fill(ui.visuals().code_bg_color)
                .inner_margin(6.0)
                .corner_radius(4.0)
                .show(ui, |ui| {
                    if !lang.is_empty() {
                        ui.label(egui::RichText::new(lang).small().color(WEAK));
                    }
                    clickable(ui, job, TextWrapMode::Extend)
                })
                .inner
        }
    }
}

fn clickable(ui: &mut Ui, job: LayoutJob, wrap: TextWrapMode) -> bool {
    ui.add(Label::new(job).wrap_mode(wrap).sense(Sense::click()))
        .clicked()
}

fn body_font() -> FontId {
    FontId::proportional(15.0)
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

fn inline_job(ui: &Ui, text: &str, base: FontId, color: Color32, heading: bool) -> LayoutJob {
    let mut job = LayoutJob::default();
    job.wrap.max_width = ui.available_width();
    job.break_on_newline = true;

    let plain = TextFormat::simple(base.clone(), color);
    let link_color = ui.visuals().hyperlink_color;
    let code_bg = ui.visuals().code_bg_color;

    let mut emphasis = 0usize;
    let mut strong = 0usize;
    let mut strike = 0usize;
    let mut link = false;

    for event in Parser::new_ext(text, Options::empty()) {
        match event {
            Event::Start(Tag::Emphasis) => emphasis += 1,
            Event::End(TagEnd::Emphasis) => emphasis = emphasis.saturating_sub(1),
            Event::Start(Tag::Strong) => strong += 1,
            Event::End(TagEnd::Strong) => strong = strong.saturating_sub(1),
            Event::Start(Tag::Strikethrough) => strike += 1,
            Event::End(TagEnd::Strikethrough) => strike = strike.saturating_sub(1),
            Event::Start(Tag::Link { .. }) => link = true,
            Event::End(TagEnd::Link) => link = false,
            Event::Text(value) => {
                let mut format = TextFormat::simple(base.clone(), color);
                format.italics = emphasis > 0;
                if heading || strong > 0 {
                    format.color = STRONG;
                }
                if strike > 0 {
                    format.strikethrough = Stroke::new(1.0, format.color);
                }
                if link {
                    format.color = link_color;
                    format.underline = Stroke::new(1.0, link_color);
                }
                job.append(&value, 0.0, format);
            }
            Event::Code(value) => {
                let mut format = TextFormat::simple(FontId::monospace(base.size * 0.95), color);
                format.background = code_bg;
                job.append(&value, 0.0, format);
            }
            Event::SoftBreak => job.append(" ", 0.0, plain.clone()),
            Event::HardBreak => job.append("\n", 0.0, plain.clone()),
            _ => {}
        }
    }

    job
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
}
