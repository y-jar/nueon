//! Translation execution runner: English input to conlang output.

use std::collections::BTreeSet;

use egui::{RichText, Ui};

use crate::model::{translate, WORDNAME_TAG};
use crate::translation::ClauseSlot;
use crate::workspace::Workspace;

use super::state::{NewWordDraft, UiState};

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
        state.translation_run.drafts.clear();
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
        if !report.missing.is_empty() {
            missing_editor(ui, ws, state, &report);
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

fn default_table(ws: &Workspace, state: &UiState) -> Option<String> {
    let exists = |name: &str| {
        ws.dictionary
            .table(name)
            .is_some()
            .then(|| name.to_string())
    };
    state
        .translation_run
        .target_table
        .as_deref()
        .and_then(exists)
        .or_else(|| ws.settings.default_table.as_deref().and_then(exists))
        .or_else(|| exists("all words"))
        .or_else(|| ws.dictionary.table_names().first().map(|s| s.to_string()))
}

fn missing_editor(
    ui: &mut Ui,
    ws: &mut Workspace,
    state: &mut UiState,
    report: &translate::TranslationReport,
) {
    ui.separator();
    ui.label(RichText::new("Missing words").strong());

    let tables: Vec<String> = ws
        .dictionary
        .table_names()
        .iter()
        .map(|name| (*name).to_string())
        .collect();
    if tables.is_empty() {
        ui.label(RichText::new("Create a table in the Dictionary tab first.").weak());
        return;
    }
    let default = default_table(ws, state);

    ui.horizontal(|ui| {
        ui.label("Create in:");
        let current = state
            .translation_run
            .target_table
            .clone()
            .or_else(|| default.clone())
            .unwrap_or_default();
        egui::ComboBox::from_id_salt("missing_target_table")
            .selected_text(current.clone())
            .show_ui(ui, |ui| {
                for table in &tables {
                    if ui.selectable_label(&current == table, table).clicked() {
                        state.translation_run.target_table = Some(table.clone());
                    }
                }
            });
    });

    let suggested: Vec<String> = report
        .unfilled
        .iter()
        .filter_map(|index| report.slots.get(*index))
        .filter_map(|outcome| match &outcome.slot {
            ClauseSlot::RequiredTag { tag } => Some(tag.clone()),
            _ => None,
        })
        .collect();

    let mut status: Option<String> = None;
    let mut finished: Vec<usize> = Vec::new();

    for &index in &report.missing {
        let Some(token) = report.tokens.get(index) else {
            continue;
        };
        let draft = state
            .translation_run
            .drafts
            .entry(index)
            .or_insert_with(|| NewWordDraft {
                wordname: String::new(),
                definition: token.text.clone(),
                tags: Vec::new(),
                table: None,
            });

        let effective = draft.table.clone().or_else(|| default.clone());
        let declared: Vec<String> = effective
            .as_deref()
            .and_then(|table| ws.dictionary.table(table))
            .map(|table| {
                table
                    .tags
                    .iter()
                    .filter(|tag| tag.name != WORDNAME_TAG)
                    .map(|tag| tag.name.clone())
                    .collect()
            })
            .unwrap_or_default();
        let all_tags: Vec<String> = declared
            .into_iter()
            .chain(suggested.iter().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();

        egui::Frame::group(ui.style()).show(ui, |ui| {
            ui.label(RichText::new(format!("missing: {}", token.text)).weak());
            ui.horizontal(|ui| {
                ui.add(
                    egui::TextEdit::singleline(&mut draft.wordname)
                        .hint_text(&token.text)
                        .desired_width(140.0),
                );
                ui.add(
                    egui::TextEdit::singleline(&mut draft.definition)
                        .hint_text("definition")
                        .desired_width(160.0),
                );
            });
            ui.horizontal(|ui| {
                ui.label("table:");
                let label = draft
                    .table
                    .clone()
                    .unwrap_or_else(|| "inherit default".to_string());
                egui::ComboBox::from_id_salt(("draft_table", index))
                    .selected_text(label)
                    .show_ui(ui, |ui| {
                        if ui
                            .selectable_label(draft.table.is_none(), "inherit default")
                            .clicked()
                        {
                            draft.table = None;
                        }
                        for table in &tables {
                            let selected = draft.table.as_deref() == Some(table.as_str());
                            if ui.selectable_label(selected, table).clicked() {
                                draft.table = Some(table.clone());
                            }
                        }
                    });
            });
            ui.horizontal_wrapped(|ui| {
                ui.label("tags:");
                for name in &all_tags {
                    let mut on = draft.tags.contains(name);
                    if ui.checkbox(&mut on, name).changed() {
                        if on {
                            draft.tags.push(name.clone());
                        } else {
                            draft.tags.retain(|tag| tag != name);
                        }
                    }
                }
            });
            ui.horizontal(|ui| {
                let can_create = effective.is_some() && !draft.wordname.trim().is_empty();
                if ui
                    .add_enabled(can_create, egui::Button::new("＋ Create"))
                    .clicked()
                {
                    let table = effective.clone().unwrap();
                    match ws.create_defined_entry(
                        &table,
                        draft.wordname.trim(),
                        &draft.definition,
                        &draft.tags,
                    ) {
                        Ok(Some(_)) => {
                            status = Some(format!(
                                "Created \"{}\" in \"{table}\"",
                                draft.wordname.trim()
                            ));
                            finished.push(index);
                        }
                        Ok(None) => {}
                        Err(err) => status = Some(format!("Create failed: {err}")),
                    }
                }
            });
        });
    }

    for index in finished {
        state.translation_run.drafts.remove(&index);
    }
    if let Some(message) = status {
        state.status = Some(message);
    }
}
