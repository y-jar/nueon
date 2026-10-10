//! The endings coverage grid for a word class.

use super::*;

/// A cell in the endings grid: the ending resolved for one (combination, slot).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GridCell {
    pub slot: Option<String>,
    /// Whether a rule matched (an empty cell is a coverage gap).
    pub defined: bool,
    /// Equal-specificity ties that also matched (an ambiguous cell).
    pub ambiguous: bool,
    pub zero: bool,
    pub kind: AffixKind,
    /// The inline surface (used when neither a morpheme nor zero is set).
    pub surface: String,
    /// The referenced morpheme, if any (for the picker to preselect).
    pub morpheme: Option<MorphemeRef>,
    /// A display form: the morpheme's bare surface, the inline surface, or "∅".
    pub preview: String,
}

/// One feature combination (a grid row), with a cell per slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GridRow {
    pub when: BTreeMap<String, String>,
    pub cells: Vec<GridCell>,
}

/// The endings grid for a class: its slot columns and covered combinations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParadigmGrid {
    pub slots: Vec<Option<String>>,
    pub rows: Vec<GridRow>,
    /// Total combinations before the display cap.
    pub total: usize,
}

/// The maximum number of combination rows the grid renders.
pub const GRID_CAP: usize = 64;

fn grid_cell(
    slot: Option<String>,
    row: &ParadigmRow,
    ambiguous: bool,
    morphemes: &[Morpheme],
) -> GridCell {
    let preview = if row.zero {
        "∅".to_string()
    } else if let Some(reference) = row.morpheme.as_ref() {
        find_morpheme_ref(morphemes, reference)
            .map(|morpheme| morpheme.surface.clone())
            .unwrap_or_else(|| row.surface.clone())
    } else {
        row.surface.clone()
    };
    GridCell {
        slot,
        defined: true,
        ambiguous,
        zero: row.zero,
        kind: row.kind,
        surface: row.surface.clone(),
        morpheme: row.morpheme.clone(),
        preview,
    }
}

/// Build the endings coverage grid for `class`: columns are the class's slots,
/// rows are the combinations of the features it uses (referenced + inherent),
/// each cell the winning ending (empty = a coverage gap, flagged if ambiguous).
pub fn paradigm_grid(
    dict: &Dictionary,
    morphology: &Morphology,
    morphemes: &[Morpheme],
    class: &str,
) -> ParadigmGrid {
    let rows: &[ParadigmRow] = morphology
        .paradigms
        .iter()
        .find(|paradigm| paradigm.class == class)
        .map(|paradigm| paradigm.rows.as_slice())
        .unwrap_or(&[]);

    // Slot columns, ordered by the smallest `order` seen in that slot.
    let mut slots: Vec<(i32, Option<String>)> = Vec::new();
    for row in rows {
        match slots.iter_mut().find(|(_, slot)| *slot == row.slot) {
            Some((order, _)) => *order = (*order).min(row.order),
            None => slots.push((row.order, row.slot.clone())),
        }
    }
    slots.sort_by_key(|(order, _)| *order);
    let slot_list: Vec<Option<String>> = if slots.is_empty() {
        vec![None]
    } else {
        slots.into_iter().map(|(_, slot)| slot).collect()
    };

    // Features the class uses: referenced by its rows, plus inherent (bound).
    let mut used: Vec<String> = Vec::new();
    for row in rows {
        for feature in row.when.keys() {
            if !used.contains(feature) {
                used.push(feature.clone());
            }
        }
    }
    // An inherent feature counts as used when the class's own words carry a
    // value in its bound column (so unrelated classes don't show it).
    let column = class_column(dict, morphology);
    let class_uses_column = |binding: &FeatureColumn| {
        dict.table(&binding.table).is_some_and(|table| {
            table.entries.iter().any(|entry| {
                word_class(entry, &column) == Some(class)
                    && entry_text(entry, &binding.column).is_some_and(|value| !value.is_empty())
            })
        })
    };
    for feature in &morphology.features {
        if let Some(binding) = &feature.column {
            if !used.contains(&feature.id) && class_uses_column(binding) {
                used.push(feature.id.clone());
            }
        }
    }
    let grid_features: Vec<&Feature> = morphology
        .features
        .iter()
        .filter(|feature| used.contains(&feature.id))
        .collect();

    // Values per feature: inherent reads the bound column (with an "unset" "");
    // inflectional uses the declared values.
    let values_per: Vec<Vec<String>> = grid_features
        .iter()
        .map(|feature| match &feature.column {
            Some(binding) => {
                let mut values = vec![String::new()];
                values.extend(inherent_values(dict, &binding.table, &binding.column));
                values
            }
            None => feature
                .values
                .iter()
                .map(|value| value.id.clone())
                .collect(),
        })
        .collect();

    // Cartesian product, capped at GRID_CAP rows.
    let mut combos: Vec<BTreeMap<String, String>> = vec![BTreeMap::new()];
    for (feature, values) in grid_features.iter().zip(&values_per) {
        let mut next = Vec::new();
        'outer: for combo in &combos {
            for value in values {
                let mut built = combo.clone();
                built.insert(feature.id.clone(), value.clone());
                next.push(built);
                if next.len() >= GRID_CAP {
                    break 'outer;
                }
            }
        }
        combos = next;
    }
    let total = values_per
        .iter()
        .fold(1usize, |acc, values| acc * values.len().max(1));

    let resolved: Vec<GridRow> = combos
        .into_iter()
        .map(|combo| {
            let cells = slot_list
                .iter()
                .map(|slot| {
                    let matching: Vec<&ParadigmRow> = rows
                        .iter()
                        .filter(|row| {
                            !row.when.is_empty()
                                && &row.slot == slot
                                && row
                                    .when
                                    .iter()
                                    .all(|(feature, value)| combo.get(feature) == Some(value))
                        })
                        .collect();
                    if matching.is_empty() {
                        return GridCell {
                            slot: slot.clone(),
                            defined: false,
                            ambiguous: false,
                            zero: false,
                            kind: AffixKind::Suffix,
                            surface: String::new(),
                            morpheme: None,
                            preview: String::new(),
                        };
                    }
                    let max = matching.iter().map(|row| row.when.len()).max().unwrap_or(0);
                    let mut top: Vec<&ParadigmRow> = matching
                        .into_iter()
                        .filter(|row| row.when.len() == max)
                        .collect();
                    let winner = top.remove(0);
                    grid_cell(slot.clone(), winner, !top.is_empty(), morphemes)
                })
                .collect();
            GridRow { when: combo, cells }
        })
        .collect();

    ParadigmGrid {
        slots: slot_list,
        rows: resolved,
        total,
    }
}
