//! Warm, low-saturation earthy theme.

use egui::{Color32, CornerRadius, Stroke, Visuals};

const PANEL: Color32 = Color32::from_rgb(38, 34, 30);
const FAINT: Color32 = Color32::from_rgb(46, 41, 36);
const EXTREME: Color32 = Color32::from_rgb(24, 21, 19);
const WIDGET_BG: Color32 = Color32::from_rgb(52, 46, 40);
const WIDGET_HOVER: Color32 = Color32::from_rgb(66, 58, 49);
const WIDGET_ACTIVE: Color32 = Color32::from_rgb(80, 70, 58);
const BORDER: Color32 = Color32::from_rgb(58, 51, 44);
const TEXT: Color32 = Color32::from_rgb(226, 216, 200);
const ACCENT: Color32 = Color32::from_rgb(196, 148, 92);

/// Apply the earthy theme to an egui context.
pub fn apply(ctx: &egui::Context) {
    let mut visuals = Visuals::dark();
    let corner = CornerRadius::same(6);

    visuals.panel_fill = PANEL;
    visuals.window_fill = PANEL;
    visuals.extreme_bg_color = EXTREME;
    visuals.faint_bg_color = FAINT;
    visuals.code_bg_color = EXTREME;
    visuals.override_text_color = Some(TEXT);
    visuals.hyperlink_color = ACCENT;
    visuals.selection.bg_fill = ACCENT.gamma_multiply(0.45);
    visuals.selection.stroke = Stroke::new(1.0, ACCENT);

    visuals.widgets.noninteractive.bg_fill = PANEL;
    visuals.widgets.noninteractive.weak_bg_fill = PANEL;
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0, BORDER);
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.noninteractive.corner_radius = corner;

    visuals.widgets.inactive.bg_fill = WIDGET_BG;
    visuals.widgets.inactive.weak_bg_fill = WIDGET_BG;
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0, BORDER);
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.inactive.corner_radius = corner;

    visuals.widgets.hovered.bg_fill = WIDGET_HOVER;
    visuals.widgets.hovered.weak_bg_fill = WIDGET_HOVER;
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0, ACCENT);
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0, Color32::WHITE);
    visuals.widgets.hovered.corner_radius = corner;

    visuals.widgets.active.bg_fill = WIDGET_ACTIVE;
    visuals.widgets.active.weak_bg_fill = WIDGET_ACTIVE;
    visuals.widgets.active.bg_stroke = Stroke::new(1.0, ACCENT);
    visuals.widgets.active.corner_radius = corner;

    visuals.widgets.open.bg_fill = WIDGET_HOVER;
    visuals.widgets.open.weak_bg_fill = WIDGET_HOVER;
    visuals.widgets.open.corner_radius = corner;

    ctx.set_visuals(visuals);

    ctx.all_styles_mut(|style| {
        style.spacing.item_spacing = egui::vec2(8.0, 6.0);
        style.spacing.button_padding = egui::vec2(8.0, 4.0);
    });
}
