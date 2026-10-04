//! Translation execution runner: English input to conlang output.

use egui::{RichText, Ui};

use crate::model::translate;
use crate::workspace::Workspace;

use super::state::UiState;

/// The execution section shown below the builder.
pub fn run(ui: &mut Ui, ws: &mut Workspace, state: &mut UiState) {
    ui.separator();
    ui.label(RichText::new("Execute").strong());

    ui.horizontal(|ui| {
        ui.label("separator:");
        ui.add(
            egui::TextEdit::singleline(&mut state.translation_run.separator).desired_width(36.0),
        );
        ui.label(RichText::new("(between words)").weak());
    });

    let input_response = ui.add(
        egui::TextEdit::multiline(&mut state.translation_run.input)
            .hint_text("English sentence")
            .desired_rows(2)
            .desired_width(f32::INFINITY),
    );
    if input_response.changed() {
        state.translation_run.choices.clear();
        state.translation_run.ran = false;
    }

    if ui.button("Translate").clicked() {
        state.translation_run.ran = true;
        let separator = state.translation_run.separator.clone();
        ws.translation
            .settings
            .insert("word_separator".to_string(), separator);
        if let Err(err) = ws.save_translation() {
            state.status = Some(format!("Save failed: {err}"));
        }
    }

    if !state.translation_run.ran || state.translation_run.input.trim().is_empty() {
        return;
    }

    let separator = if state.translation_run.separator.is_empty() {
        " ".to_string()
    } else {
        state.translation_run.separator.clone()
    };
    let grid = state.translation.draft.clone();

    // First pass to discover conflicts, then render the pickers.
    let preliminary = translate::translate(
        &ws.dictionary,
        &grid,
        &separator,
        &state.translation_run.input,
        &state.translation_run.choices,
    );

    if !preliminary.conflicts.is_empty() {
        ui.label(RichText::new("Conflicts — choose a meaning:").strong());
        for &index in &preliminary.conflicts {
            let Some(token) = preliminary.tokens.get(index) else {
                continue;
            };
            ui.horizontal(|ui| {
                ui.label(RichText::new(&token.text).strong());
                let selected = state
                    .translation_run
                    .choices
                    .get(&index)
                    .and_then(|id| ws.dictionary.find_entry(*id))
                    .map(|(_, entry)| entry.wordname.clone());
                egui::ComboBox::from_id_salt(("conflict", index))
                    .selected_text(selected.unwrap_or_else(|| "choose…".to_string()))
                    .show_ui(ui, |ui| {
                        for candidate in translate::token_candidates(&ws.dictionary, token) {
                            let label = format!("{} · {}", candidate.wordname, candidate.table);
                            if ui.selectable_label(false, label).clicked() {
                                state.translation_run.choices.insert(index, candidate.id);
                            }
                        }
                    });
            });
        }
    }

    // Final pass with the latest choices.
    let report = translate::translate(
        &ws.dictionary,
        &grid,
        &separator,
        &state.translation_run.input,
        &state.translation_run.choices,
    );

    ui.add_space(4.0);
    ui.label(RichText::new("Output").strong());
    egui::Frame::NONE
        .fill(ui.visuals().extreme_bg_color)
        .inner_margin(6.0)
        .corner_radius(4.0)
        .show(ui, |ui| {
            let text = if report.output.is_empty() {
                RichText::new("(empty)").weak()
            } else {
                RichText::new(&report.output).monospace()
            };
            ui.add(egui::Label::new(text).wrap_mode(egui::TextWrapMode::Wrap));
        });

    if report.complete {
        ui.colored_label(ui.visuals().hyperlink_color, "complete");
    } else {
        ui.colored_label(ui.visuals().warn_fg_color, "incomplete");
        if !report.missing.is_empty() {
            ui.label(format!(
                "Missing words: {}",
                words(&report, &report.missing)
            ));
        }
        if !report.unfilled.is_empty() {
            let slots: Vec<String> = report
                .unfilled
                .iter()
                .map(|index| format!("#{index}"))
                .collect();
            ui.label(format!("Unfilled slots: {}", slots.join(", ")));
        }
        if !report.leftovers.is_empty() {
            let indices: Vec<usize> = report.leftovers.iter().map(|(index, _)| *index).collect();
            ui.label(format!("Unplaced words: {}", words(&report, &indices)));
        }
    }

    egui::CollapsingHeader::new("Breakdown")
        .default_open(true)
        .show(ui, |ui| {
            for outcome in &report.slots {
                let symbol = match &outcome.symbol {
                    translate::Symbol::Word(word) => word.clone(),
                    translate::Symbol::Literal(text) => format!("\"{text}\""),
                    translate::Symbol::Separator => "␣".to_string(),
                    translate::Symbol::Placeholder(text) => format!("⟨{text}⟩"),
                };
                ui.horizontal(|ui| {
                    ui.label(RichText::new(outcome.slot.label()).monospace());
                    ui.label("→");
                    ui.label(RichText::new(symbol).monospace());
                });
            }
        });
}

fn words(report: &translate::TranslationReport, indices: &[usize]) -> String {
    indices
        .iter()
        .filter_map(|index| report.tokens.get(*index))
        .map(|token| token.text.clone())
        .collect::<Vec<_>>()
        .join(", ")
}
