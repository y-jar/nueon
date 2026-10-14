//! OpenType layout for the writing system: orthography rules compiled to GSUB.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use write_fonts::tables::gsub::builders::{
    LigatureSubBuilder, MultipleSubBuilder, SingleSubBuilder,
};
use write_fonts::tables::gsub::{
    Gsub, SubstitutionChainContext, SubstitutionLookup, SubstitutionLookupList,
};
use write_fonts::tables::layout::builders::{Builder, CoverageTableBuilder};
use write_fonts::tables::layout::{
    ChainedSequenceContext, ChainedSequenceContextFormat3, CoverageTable, Feature, FeatureList,
    FeatureRecord, LangSys, Lookup, LookupFlag, Script, ScriptList, ScriptRecord,
    SequenceLookupRecord,
};
use write_fonts::tables::variations::ivs_builder::VariationStoreBuilder;
use write_fonts::types::{GlyphId16, Tag};

use crate::config::{OrthographyRule, Phoneme, PhonemeKind};

use super::compile::FontGlyph;
use super::validate::{FontIssue, Severity};

/// The feature every romanisation and contextual substitution lives in. Shapers
/// apply it by default for the default script, so no keyboard or setting is needed.
pub const FEATURE: &[u8; 4] = b"calt";

/// Advance given to the space glyph so words stay apart.
pub const SPACE_ADVANCE: u16 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unit {
    Literal(char),
    Class(PhonemeKind),
    Boundary,
}

#[derive(Debug, Clone)]
struct Prepared {
    index: usize,
    input: Vec<char>,
    output: Vec<u16>,
    left: Vec<Unit>,
    right: Vec<Unit>,
}

/// What the compiler adds to the font for the rules.
#[derive(Debug, Clone, Default)]
pub struct Layout {
    /// Characters that need a hidden glyph so they can be typed, sorted. Their
    /// glyph index is the number of user glyphs, plus one, plus their position.
    pub sources: Vec<char>,
    pub gsub: Option<Gsub>,
    /// The longest span of glyphs a rule looks at, for `OS/2.usMaxContext`.
    pub max_context: u16,
}

fn parse_context(spec: &Option<String>) -> Vec<Unit> {
    spec.as_deref()
        .unwrap_or("")
        .chars()
        .map(|c| match c {
            'C' => Unit::Class(PhonemeKind::Consonant),
            'V' => Unit::Class(PhonemeKind::Vowel),
            'L' => Unit::Class(PhonemeKind::Other),
            '#' => Unit::Boundary,
            other => Unit::Literal(other),
        })
        .collect()
}

fn describe(rule: &OrthographyRule) -> String {
    rule.name.clone().unwrap_or_else(|| rule.from.clone())
}

fn note(
    index: usize,
    rule: &OrthographyRule,
    severity: Severity,
    code: &'static str,
    message: String,
) -> FontIssue {
    FontIssue {
        glyph: format!("rule:{index}"),
        name: format!("rule {}", describe(rule)),
        severity,
        code,
        message,
    }
}

fn class_chars(phonemes: &[Phoneme], kind: PhonemeKind, last: bool) -> BTreeSet<char> {
    phonemes
        .iter()
        .filter(|p| p.kind == kind)
        .filter_map(|p| {
            if last {
                p.symbol.chars().last()
            } else {
                p.symbol.chars().next()
            }
        })
        .collect()
}

fn coverage(ids: &BTreeSet<u16>) -> CoverageTable {
    CoverageTableBuilder::from_glyphs(ids.iter().map(|&i| GlyphId16::new(i)).collect()).build()
}

fn gid(id: u16) -> GlyphId16 {
    GlyphId16::new(id)
}

fn vars() -> VariationStoreBuilder {
    VariationStoreBuilder::new(0)
}

/// Compile orthography rules into a layout, and report what could not be used.
///
/// Each rule becomes its own lookup, in the order written, so an earlier rule
/// always acts before a later one: a rule without context is a single, multiple
/// or ligature substitution, and a rule with a left or right context is a
/// chaining context that calls it. A context that looks backwards also accepts
/// the glyph an earlier rule produced for that letter, since a shaper's
/// backtrack sees the glyphs as substituted so far.
pub fn plan_layout(
    glyphs: &[FontGlyph],
    rules: &[OrthographyRule],
    phonemes: &[Phoneme],
) -> (Layout, Vec<FontIssue>) {
    let mut issues = Vec::new();
    let by_id: HashMap<&str, u16> = glyphs
        .iter()
        .enumerate()
        .map(|(i, g)| (g.meta.id.as_str(), i as u16 + 1))
        .collect();
    let by_codepoint: HashMap<u32, u16> = glyphs
        .iter()
        .enumerate()
        .map(|(i, g)| (g.meta.codepoint, i as u16 + 1))
        .collect();

    let mut prepared: Vec<Prepared> = Vec::new();
    for (index, rule) in rules.iter().enumerate() {
        let input: Vec<char> = rule.from.chars().collect();
        if input.is_empty() {
            issues.push(note(
                index,
                rule,
                Severity::Warning,
                "rule-empty",
                "has no text to match and is skipped".into(),
            ));
            continue;
        }
        if rule.to.is_empty() {
            issues.push(note(
                index,
                rule,
                Severity::Warning,
                "rule-no-output",
                "emits no glyphs and is skipped".into(),
            ));
            continue;
        }
        let mut output = Vec::new();
        let mut unknown = false;
        for id in &rule.to {
            match by_id.get(id.as_str()) {
                Some(&found) => output.push(found),
                None => {
                    unknown = true;
                    issues.push(note(
                        index,
                        rule,
                        Severity::Error,
                        "rule-unknown-glyph",
                        format!("emits the glyph \"{id}\", which does not exist"),
                    ));
                }
            }
        }
        if unknown {
            continue;
        }
        if input.len() > 1 && output.len() > 1 {
            issues.push(note(
                index,
                rule,
                Severity::Warning,
                "rule-unsupported",
                format!(
                    "turns {} letters into {} glyphs; use one glyph for several letters, or one letter for several glyphs. The rule is skipped",
                    input.len(),
                    output.len()
                ),
            ));
            continue;
        }
        let left = parse_context(&rule.left);
        let right = parse_context(&rule.right);
        if left.iter().chain(&right).any(|u| *u == Unit::Boundary) {
            issues.push(note(
                index,
                rule,
                Severity::Info,
                "rule-boundary",
                "a word boundary (#) matches next to a space; it does not match at the very start or end of the text".into(),
            ));
        }
        prepared.push(Prepared {
            index,
            input,
            output,
            left,
            right,
        });
    }

    let joining = resolve_forms(glyphs, &by_id, &mut issues);
    if prepared.is_empty() && joining.is_empty() {
        return (Layout::default(), issues);
    }

    let mut needed: BTreeSet<char> = BTreeSet::from([' ']);
    for rule in &prepared {
        needed.extend(rule.input.iter().copied());
        for (units, last) in [(&rule.left, true), (&rule.right, false)] {
            for unit in units {
                match unit {
                    Unit::Literal(c) => {
                        needed.insert(*c);
                    }
                    Unit::Class(kind) => needed.extend(class_chars(phonemes, *kind, last)),
                    Unit::Boundary => {}
                }
            }
        }
    }
    let sources: Vec<char> = needed
        .iter()
        .copied()
        .filter(|c| !by_codepoint.contains_key(&(*c as u32)))
        .collect();
    let mut char_gid: BTreeMap<char, u16> = BTreeMap::new();
    for c in &needed {
        let found = by_codepoint.get(&(*c as u32)).copied().unwrap_or_else(|| {
            let at = sources.iter().position(|s| s == c).unwrap_or(0);
            glyphs.len() as u16 + 1 + at as u16
        });
        char_gid.insert(*c, found);
    }
    let space = char_gid[&' '];

    let mut tail_alias: BTreeMap<char, BTreeSet<u16>> = BTreeMap::new();
    for rule in &prepared {
        if let (Some(last), Some(out)) = (rule.input.last(), rule.output.last()) {
            tail_alias.entry(*last).or_default().insert(*out);
        }
    }

    let unit_cover = |unit: &Unit, backwards: bool| -> BTreeSet<u16> {
        let chars: BTreeSet<char> = match unit {
            Unit::Literal(c) => BTreeSet::from([*c]),
            Unit::Boundary => return BTreeSet::from([space]),
            Unit::Class(kind) => class_chars(phonemes, *kind, backwards),
        };
        let mut ids = BTreeSet::new();
        for c in chars {
            if let Some(&g) = char_gid.get(&c) {
                ids.insert(g);
            }
            if backwards {
                if let Some(aliases) = tail_alias.get(&c) {
                    ids.extend(aliases);
                }
            }
        }
        ids
    };

    let mut lookups: Vec<SubstitutionLookup> = Vec::new();
    let mut feature_lookups: Vec<u16> = Vec::new();
    let mut max_context = 1usize;

    for rule in &prepared {
        let inputs: Vec<u16> = rule.input.iter().map(|c| char_gid[c]).collect();
        max_context = max_context.max(rule.left.len() + inputs.len() + rule.right.len());
        let backtrack: Vec<BTreeSet<u16>> = rule
            .left
            .iter()
            .rev()
            .map(|u| unit_cover(u, true))
            .collect();
        let lookahead: Vec<BTreeSet<u16>> =
            rule.right.iter().map(|u| unit_cover(u, false)).collect();
        if backtrack.iter().chain(&lookahead).any(|set| set.is_empty()) {
            issues.push(note(
                rule.index,
                &rules[rule.index],
                Severity::Warning,
                "rule-empty-class",
                "its context names a sound class with no sounds in the inventory, so it can never match".into(),
            ));
            continue;
        }

        let flag = LookupFlag::empty();
        let target = match (inputs.len(), rule.output.len()) {
            (1, 1) => {
                let mut b = SingleSubBuilder::default();
                b.insert(gid(inputs[0]), gid(rule.output[0]));
                SubstitutionLookup::Single(Lookup::new(flag, b.build(&mut vars())))
            }
            (1, _) => {
                let mut b = MultipleSubBuilder::default();
                b.insert(
                    gid(inputs[0]),
                    rule.output.iter().map(|&g| gid(g)).collect(),
                );
                SubstitutionLookup::Multiple(Lookup::new(flag, b.build(&mut vars())))
            }
            _ => {
                let mut b = LigatureSubBuilder::default();
                b.insert(
                    inputs.iter().map(|&g| gid(g)).collect(),
                    gid(rule.output[0]),
                );
                SubstitutionLookup::Ligature(Lookup::new(flag, b.build(&mut vars())))
            }
        };
        if backtrack.is_empty() && lookahead.is_empty() {
            feature_lookups.push(lookups.len() as u16);
            lookups.push(target);
        } else {
            let chain_at = lookups.len() as u16;
            feature_lookups.push(chain_at);
            lookups.push(SubstitutionLookup::ChainContextual(Lookup::new(
                flag,
                vec![SubstitutionChainContext::from(
                    ChainedSequenceContext::Format3(ChainedSequenceContextFormat3::new(
                        backtrack.iter().map(coverage).collect(),
                        inputs
                            .iter()
                            .map(|&g| coverage(&BTreeSet::from([g])))
                            .collect(),
                        lookahead.iter().map(coverage).collect(),
                        vec![SequenceLookupRecord::new(0, chain_at + 1)],
                    )),
                )],
            )));
            lookups.push(target);
        }
    }
    if !joining.is_empty() {
        feature_lookups.push(lookups.len() as u16);
        positional_lookups(&joining, &mut lookups);
        max_context = max_context.max(3);
    }
    if lookups.is_empty() {
        return (Layout::default(), issues);
    }

    let scripts = ScriptList::new(vec![ScriptRecord::new(
        Tag::new(b"DFLT"),
        Script::new(Some(LangSys::new(vec![0])), vec![]),
    )]);
    let features = FeatureList::new(vec![FeatureRecord::new(
        Tag::new(FEATURE),
        Feature::new(None, feature_lookups),
    )]);
    let gsub = Gsub::new(scripts, features, SubstitutionLookupList::new(lookups));
    (
        Layout {
            sources,
            gsub: Some(gsub),
            max_context: max_context.min(u16::MAX as usize) as u16,
        },
        issues,
    )
}

/// A glyph with positional alternates, as glyph indices.
#[derive(Debug, Clone, Copy)]
struct Joining {
    base: u16,
    initial: Option<u16>,
    medial: Option<u16>,
    last: Option<u16>,
}

fn resolve_forms(
    glyphs: &[FontGlyph],
    by_id: &HashMap<&str, u16>,
    issues: &mut Vec<FontIssue>,
) -> Vec<Joining> {
    let mut joining = Vec::new();
    for (index, glyph) in glyphs.iter().enumerate() {
        let forms = &glyph.meta.forms;
        if forms.is_empty() {
            continue;
        }
        let base = index as u16 + 1;
        let mut resolve = |label: &str, id: &Option<String>| -> Option<u16> {
            let id = id.as_ref()?;
            let found = by_id.get(id.as_str()).copied();
            let problem = match found {
                None => Some((
                    Severity::Error,
                    "form-unknown-glyph",
                    format!("its {label} form is the glyph \"{id}\", which does not exist"),
                )),
                Some(g) if g == base => Some((
                    Severity::Warning,
                    "form-self",
                    format!("its {label} form is the glyph itself, so nothing changes"),
                )),
                _ => None,
            };
            if let Some((severity, code, message)) = problem {
                issues.push(FontIssue {
                    glyph: glyph.meta.id.clone(),
                    name: glyph.meta.name.clone(),
                    severity,
                    code,
                    message,
                });
                return None;
            }
            found
        };
        let entry = Joining {
            base,
            initial: resolve("initial", &forms.initial),
            medial: resolve("medial", &forms.medial),
            last: resolve("final", &forms.final_form),
        };
        if entry.initial.is_some() || entry.medial.is_some() || entry.last.is_some() {
            joining.push(entry);
        }
    }
    let connects_ahead = joining
        .iter()
        .any(|j| j.initial.is_some() || j.medial.is_some());
    let joins_behind = joining
        .iter()
        .any(|j| j.medial.is_some() || j.last.is_some());
    for entry in &joining {
        let glyph = &glyphs[entry.base as usize - 1];
        let mut dead: Vec<&str> = Vec::new();
        if entry.initial.is_some() && !joins_behind {
            dead.push("initial");
        }
        if entry.medial.is_some() && !(connects_ahead && joins_behind) {
            dead.push("medial");
        }
        if entry.last.is_some() && !connects_ahead {
            dead.push("final");
        }
        if !dead.is_empty() {
            issues.push(FontIssue {
                glyph: glyph.meta.id.clone(),
                name: glyph.meta.name.clone(),
                severity: Severity::Warning,
                code: "form-unreachable",
                message: format!(
                    "its {} form can never apply: no other glyph has a form to join to",
                    dead.join(" and ")
                ),
            });
        }
    }
    joining
}

/// Append the positional-forms lookups: one chaining lookup, then a single
/// substitution per form. At each joining glyph, in this order and first match
/// wins: medial (joined on both sides), final (joined behind only), initial
/// (joined ahead only). A no-op medial subtable stops a glyph that lacks a medial
/// form, but sits between two joiners, from falling through to the initial form. A glyph is "joined behind"
/// when the glyph before it came out as an initial or medial form.
fn positional_lookups(joining: &[Joining], lookups: &mut Vec<SubstitutionLookup>) {
    let set = |pick: &dyn Fn(&Joining) -> Option<u16>| -> BTreeSet<u16> {
        joining.iter().filter_map(pick).collect()
    };
    let all: BTreeSet<u16> = joining.iter().map(|j| j.base).collect();
    let with_initial: BTreeSet<u16> = joining
        .iter()
        .filter(|j| j.initial.is_some())
        .map(|j| j.base)
        .collect();
    let with_medial: BTreeSet<u16> = joining
        .iter()
        .filter(|j| j.medial.is_some())
        .map(|j| j.base)
        .collect();
    let with_last: BTreeSet<u16> = joining
        .iter()
        .filter(|j| j.last.is_some())
        .map(|j| j.base)
        .collect();
    let joins_behind: BTreeSet<u16> = with_medial.union(&with_last).copied().collect();
    let connects_ahead: BTreeSet<u16> = set(&|j| j.initial)
        .union(&set(&|j| j.medial))
        .copied()
        .collect();

    let chain_at = lookups.len() as u16;
    let mut singles: Vec<SubstitutionLookup> = Vec::new();
    let mut single = |pairs: Vec<(u16, u16)>| -> Option<u16> {
        if pairs.is_empty() {
            return None;
        }
        let mut b = SingleSubBuilder::default();
        for (from, to) in pairs {
            b.insert(gid(from), gid(to));
        }
        singles.push(SubstitutionLookup::Single(Lookup::new(
            LookupFlag::empty(),
            b.build(&mut vars()),
        )));
        Some(chain_at + singles.len() as u16)
    };
    let to_initial = single(
        joining
            .iter()
            .filter_map(|j| j.initial.map(|f| (j.base, f)))
            .collect(),
    );
    let to_medial = single(
        joining
            .iter()
            .filter_map(|j| j.medial.map(|f| (j.base, f)))
            .collect(),
    );
    let to_last = single(
        joining
            .iter()
            .filter_map(|j| j.last.map(|f| (j.base, f)))
            .collect(),
    );

    let context = |behind: Option<&BTreeSet<u16>>,
                   input: &BTreeSet<u16>,
                   ahead: Option<&BTreeSet<u16>>,
                   call: Option<u16>| {
        SubstitutionChainContext::from(ChainedSequenceContext::Format3(
            ChainedSequenceContextFormat3::new(
                behind.map(|s| vec![coverage(s)]).unwrap_or_default(),
                vec![coverage(input)],
                ahead.map(|s| vec![coverage(s)]).unwrap_or_default(),
                call.map(|l| vec![SequenceLookupRecord::new(0, l)])
                    .unwrap_or_default(),
            ),
        ))
    };

    let mut tables = Vec::new();
    let can_join = !connects_ahead.is_empty();
    if can_join && !joins_behind.is_empty() {
        if let Some(call) = to_medial {
            tables.push(context(
                Some(&connects_ahead),
                &with_medial,
                Some(&joins_behind),
                Some(call),
            ));
        }
        tables.push(context(
            Some(&connects_ahead),
            &all,
            Some(&joins_behind),
            None,
        ));
    }
    if can_join {
        if let Some(call) = to_last {
            tables.push(context(Some(&connects_ahead), &with_last, None, Some(call)));
        }
    }
    if !joins_behind.is_empty() {
        if let Some(call) = to_initial {
            tables.push(context(
                None,
                &with_initial,
                Some(&joins_behind),
                Some(call),
            ));
        }
    }
    if tables.is_empty() {
        tables.push(context(None, &all, None, None));
    }
    lookups.push(SubstitutionLookup::ChainContextual(Lookup::new(
        LookupFlag::empty(),
        tables,
    )));
    lookups.extend(singles);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Contour, FillRule, GlyphMeta, Node, NodeKind};
    use crate::font::{compile_font, FontSettings};
    use harfrust::{shape, Buffer, Direction, Font, ShapeOptions, ShaperFont};

    fn corner(x: f64, y: f64) -> Node {
        Node {
            x,
            y,
            handle_in: None,
            handle_out: None,
            kind: NodeKind::Corner,
        }
    }

    fn glyph(id: &str, codepoint: u32, size: f64) -> FontGlyph {
        FontGlyph {
            meta: GlyphMeta {
                id: id.to_string(),
                name: id.to_string(),
                codepoint,
                phonemes: vec![],
                order: 0,
                group: String::new(),
                forms: Default::default(),
            },
            contours: vec![Contour {
                nodes: vec![
                    corner(0.0, 0.0),
                    corner(0.0, size),
                    corner(size, size),
                    corner(size, 0.0),
                ],
                closed: true,
                fill_rule: FillRule::Nonzero,
            }],
            advance: Some(size + 100.0),
        }
    }

    fn phoneme(symbol: &str, kind: PhonemeKind) -> Phoneme {
        Phoneme {
            id: symbol.to_string(),
            symbol: symbol.to_string(),
            kind,
        }
    }

    fn inventory() -> Vec<Phoneme> {
        vec![
            phoneme("k", PhonemeKind::Consonant),
            phoneme("t", PhonemeKind::Consonant),
            phoneme("a", PhonemeKind::Vowel),
            phoneme("i", PhonemeKind::Vowel),
        ]
    }

    fn rule(from: &str, to: &[&str], left: Option<&str>, right: Option<&str>) -> OrthographyRule {
        OrthographyRule {
            name: None,
            from: from.to_string(),
            to: to.iter().map(|s| s.to_string()).collect(),
            left: left.map(str::to_string),
            right: right.map(str::to_string),
        }
    }

    fn settings(rules: Vec<OrthographyRule>) -> FontSettings {
        FontSettings {
            family: "Test".to_string(),
            upem: 1000,
            ascender: 800.0,
            descender: -200.0,
            x_height: 500.0,
            cap_height: 700.0,
            rules,
            phonemes: inventory(),
        }
    }

    fn user_glyphs() -> Vec<FontGlyph> {
        vec![
            glyph("ka", 0xE000, 100.0),
            glyph("ta", 0xE001, 110.0),
            glyph("ka-final", 0xE002, 120.0),
            glyph("k-low", 0xE003, 130.0),
            glyph("a-mark", 0xE004, 140.0),
            glyph("a-tall", 0xE005, 150.0),
        ]
    }

    fn shape_ids(bytes: &[u8], text: &str) -> Vec<u32> {
        let font = Font::new(bytes.to_vec(), 0).unwrap();
        let shaper = ShaperFont::new(&font);
        let mut buffer = Buffer::new();
        buffer.push_str(text);
        buffer.set_direction(Direction::LeftToRight);
        buffer.guess_segment_properties();
        shape(&shaper, &mut buffer, ShapeOptions::new()).unwrap();
        buffer.glyph_infos().iter().map(|i| i.glyph_id).collect()
    }

    fn compile(rules: Vec<OrthographyRule>) -> (Vec<u8>, crate::font::FontReport) {
        compile_font(&settings(rules), &user_glyphs()).unwrap()
    }

    // gids: ka=1 ta=2 ka-final=3 k-low=4 a-mark=5 a-tall=6, then sources sorted: ' ', a, i, k, t

    #[test]
    fn no_rules_writes_no_layout() {
        let (bytes, report) = compile(vec![]);
        assert_eq!(report.lookups, 0);
        assert_eq!(report.source_glyphs, 0);
        let font = read_fonts::FontRef::new(&bytes).unwrap();
        assert!(font.table_data(Tag::new(b"GSUB")).is_none());
    }

    #[test]
    fn two_letters_become_one_glyph() {
        let (bytes, report) = compile(vec![rule("ka", &["ka"], None, None)]);
        assert!(report.lookups >= 1);
        assert_eq!(shape_ids(&bytes, "ka"), vec![1]);
        assert_eq!(shape_ids(&bytes, "kaka"), vec![1, 1]);
    }

    #[test]
    fn letters_without_a_rule_stay_as_their_own_hidden_glyphs() {
        let (bytes, report) = compile(vec![rule("ka", &["ka"], None, None)]);
        assert!(report.source_glyphs >= 3, "space, a, k at least");
        let ids = shape_ids(&bytes, "ak");
        assert_eq!(ids.len(), 2);
        assert!(
            ids.iter().all(|&g| g > 6),
            "source glyphs follow user glyphs: {ids:?}"
        );
    }

    #[test]
    fn an_earlier_rule_acts_before_a_later_one() {
        let (bytes, _) = compile(vec![
            rule("kai", &["ta"], None, None),
            rule("ka", &["ka"], None, None),
        ]);
        assert_eq!(
            shape_ids(&bytes, "kai"),
            vec![2],
            "the longer rule is written first"
        );
        assert_eq!(shape_ids(&bytes, "ka"), vec![1]);

        let (bytes, _) = compile(vec![
            rule("ka", &["ka"], None, None),
            rule("kai", &["ta"], None, None),
        ]);
        assert_eq!(
            shape_ids(&bytes, "kai")[0],
            1,
            "written second, the longer rule no longer sees ka"
        );
    }

    #[test]
    fn one_letter_can_become_several_glyphs() {
        let (bytes, _) = compile(vec![rule("t", &["ka", "ta"], None, None)]);
        assert_eq!(shape_ids(&bytes, "t"), vec![1, 2]);
    }

    #[test]
    fn a_single_letter_becomes_a_single_glyph() {
        let (bytes, _) = compile(vec![rule("i", &["a-mark"], None, None)]);
        assert_eq!(shape_ids(&bytes, "i"), vec![5]);
    }

    #[test]
    fn a_right_context_picks_the_variant() {
        let (bytes, _) = compile(vec![
            rule("ka", &["ka"], None, None),
            rule("k", &["k-low"], None, Some("i")),
        ]);
        let with = shape_ids(&bytes, "ki");
        let without = shape_ids(&bytes, "kt");
        assert_eq!(with[0], 4, "k before i uses the low form: {with:?}");
        assert_ne!(without[0], 4, "k before t does not: {without:?}");
    }

    #[test]
    fn a_left_context_picks_the_variant() {
        let (bytes, _) = compile(vec![rule("a", &["a-tall"], Some("k"), None)]);
        assert_eq!(shape_ids(&bytes, "ka")[1], 6, "a after k");
        assert_ne!(shape_ids(&bytes, "ta")[1], 6, "a after t");
    }

    #[test]
    fn class_contexts_use_the_inventory() {
        let (bytes, _) = compile(vec![rule("a", &["a-tall"], Some("C"), None)]);
        assert_eq!(shape_ids(&bytes, "ta")[1], 6, "a after any consonant");
        assert_eq!(shape_ids(&bytes, "ka")[1], 6);
        assert_ne!(
            shape_ids(&bytes, "ia")[1],
            6,
            "a after a vowel is untouched"
        );
    }

    #[test]
    fn a_word_boundary_matches_next_to_a_space() {
        let (bytes, report) = compile(vec![rule("a", &["a-tall"], None, Some("#"))]);
        assert!(report.lookups >= 1);
        let ids = shape_ids(&bytes, "ka ka");
        assert_eq!(ids[1], 6, "a before a space");
        assert_ne!(
            ids[4], 6,
            "a at the end of the text is not before a space: {ids:?}"
        );
    }

    #[test]
    fn a_context_rule_written_first_beats_the_plain_one() {
        let (bytes, _) = compile(vec![
            rule("a", &["a-tall"], Some("k"), None),
            rule("a", &["a-mark"], None, None),
        ]);
        assert_eq!(
            shape_ids(&bytes, "ka")[1],
            6,
            "contextual rule wins after k"
        );
        assert_eq!(shape_ids(&bytes, "ta")[1], 5, "plain rule elsewhere");
    }

    #[test]
    fn a_plain_rule_written_first_shadows_a_later_context_rule() {
        let (bytes, _) = compile(vec![
            rule("a", &["a-mark"], None, None),
            rule("a", &["a-tall"], Some("k"), None),
        ]);
        assert_eq!(
            shape_ids(&bytes, "ka")[1],
            5,
            "the plain rule already replaced a"
        );
    }

    #[test]
    fn a_context_can_follow_a_letter_an_earlier_rule_replaced() {
        let (bytes, _) = compile(vec![
            rule("k", &["k-low"], None, None),
            rule("a", &["a-tall"], Some("k"), None),
        ]);
        assert_eq!(shape_ids(&bytes, "ka"), vec![4, 6]);
    }

    #[test]
    fn bad_rules_are_skipped_and_reported_not_fatal() {
        let rules = vec![
            rule("", &["ka"], None, None),
            rule("ka", &[], None, None),
            rule("ka", &["nope"], None, None),
            rule("ka", &["ka", "ta"], None, None),
            rule("ta", &["ta"], None, None),
        ];
        let (layout, issues) = plan_layout(&user_glyphs(), &rules, &inventory());
        let codes: Vec<&str> = issues.iter().map(|i| i.code).collect();
        assert_eq!(
            codes,
            vec![
                "rule-empty",
                "rule-no-output",
                "rule-unknown-glyph",
                "rule-unsupported"
            ]
        );
        assert!(layout.gsub.is_some(), "the one good rule still compiles");
        assert_eq!(
            issues
                .iter()
                .find(|i| i.code == "rule-unknown-glyph")
                .unwrap()
                .severity,
            Severity::Error
        );
    }

    #[test]
    fn a_context_naming_an_empty_class_is_reported() {
        let mut inventory = inventory();
        inventory.retain(|p| p.kind != PhonemeKind::Other);
        let rules = vec![rule("a", &["a-tall"], Some("L"), None)];
        let (layout, issues) = plan_layout(&user_glyphs(), &rules, &inventory);
        assert_eq!(
            issues.iter().map(|i| i.code).collect::<Vec<_>>(),
            vec!["rule-empty-class"]
        );
        assert!(layout.gsub.is_none());
    }

    #[test]
    fn a_letter_that_already_has_a_glyph_is_used_directly() {
        let mut glyphs = user_glyphs();
        glyphs.push(glyph("plain-a", 'a' as u32, 90.0));
        let rules = vec![rule("ka", &["ka"], None, None)];
        let (layout, _) = plan_layout(&glyphs, &rules, &inventory());
        assert!(!layout.sources.contains(&'a'), "{:?}", layout.sources);
        let (bytes, _) = compile_font(&settings(rules), &glyphs).unwrap();
        assert_eq!(shape_ids(&bytes, "a"), vec![7]);
    }

    #[test]
    fn a_backtrack_sees_a_letter_a_contextual_rule_already_replaced() {
        let (bytes, _) = compile(vec![
            rule("k", &["k-low"], None, Some("a")),
            rule("a", &["a-tall"], Some("k"), None),
        ]);
        assert_eq!(
            shape_ids(&bytes, "ka"),
            vec![4, 6],
            "k became k-low, and a still counts it as k"
        );
    }

    #[test]
    fn the_more_specific_context_rule_must_be_written_first_to_win() {
        let (bytes, _) = compile(vec![
            rule("a", &["a-tall"], Some("k"), Some("i")),
            rule("a", &["a-mark"], Some("k"), None),
        ]);
        assert_eq!(
            shape_ids(&bytes, "kai")[1],
            6,
            "k a i is the more specific match"
        );
        assert_eq!(
            shape_ids(&bytes, "kat")[1],
            5,
            "k a t only matches the shorter rule"
        );
    }

    fn with_sh(rules: Vec<OrthographyRule>) -> Vec<u8> {
        let mut config = settings(rules);
        config.phonemes.push(phoneme("sh", PhonemeKind::Consonant));
        compile_font(&config, &user_glyphs()).unwrap().0
    }

    #[test]
    fn a_left_class_looks_at_the_last_letter_of_a_multi_letter_sound() {
        let bytes = with_sh(vec![rule("a", &["a-tall"], Some("C"), None)]);
        assert_eq!(shape_ids(&bytes, "sha")[2], 6, "a after sh: sh ends in h");
        assert_ne!(
            shape_ids(&bytes, "ia")[1],
            6,
            "a after a vowel is untouched"
        );
    }

    #[test]
    fn a_right_class_looks_at_the_first_letter_of_a_multi_letter_sound() {
        let bytes = with_sh(vec![rule("i", &["a-mark"], None, Some("C"))]);
        assert_eq!(
            shape_ids(&bytes, "ish")[0],
            5,
            "i before sh: sh starts with s"
        );
        assert_ne!(
            shape_ids(&bytes, "ia")[0],
            5,
            "i before a vowel is untouched"
        );
    }

    #[test]
    fn a_two_sound_left_context_is_read_in_written_order() {
        let (bytes, _) = compile(vec![rule("i", &["a-tall"], Some("kt"), None)]);
        assert_eq!(shape_ids(&bytes, "kti")[2], 6, "k then t then i matches");
        assert_ne!(shape_ids(&bytes, "tki")[2], 6, "t then k then i does not");
    }

    #[test]
    fn a_two_sound_right_context_is_read_in_written_order() {
        let (bytes, _) = compile(vec![rule("i", &["a-tall"], None, Some("kt"))]);
        assert_eq!(shape_ids(&bytes, "ikt")[0], 6, "i then k then t matches");
        assert_ne!(shape_ids(&bytes, "itk")[0], 6, "i then t then k does not");
    }

    fn with_forms(
        mut glyph: FontGlyph,
        initial: Option<&str>,
        medial: Option<&str>,
        last: Option<&str>,
    ) -> FontGlyph {
        glyph.meta.forms = crate::config::GlyphForms {
            initial: initial.map(str::to_string),
            medial: medial.map(str::to_string),
            final_form: last.map(str::to_string),
        };
        glyph
    }

    // gids: A=1 B=2 Ai=3 Am=4 Af=5 Bi=6 Bm=7 Bf=8 C=9 E=10 Ei=11 Ef=12
    const A: char = '\u{E000}';
    const B: char = '\u{E001}';
    const C: char = '\u{E008}';
    const E: char = '\u{E009}';
    const I: char = '\u{E00C}';

    fn joining_glyphs() -> Vec<FontGlyph> {
        vec![
            with_forms(
                glyph("A", 0xE000, 100.0),
                Some("Ai"),
                Some("Am"),
                Some("Af"),
            ),
            with_forms(
                glyph("B", 0xE001, 110.0),
                Some("Bi"),
                Some("Bm"),
                Some("Bf"),
            ),
            glyph("Ai", 0xE002, 120.0),
            glyph("Am", 0xE003, 130.0),
            glyph("Af", 0xE004, 140.0),
            glyph("Bi", 0xE005, 150.0),
            glyph("Bm", 0xE006, 160.0),
            glyph("Bf", 0xE007, 170.0),
            glyph("C", 0xE008, 180.0),
            with_forms(glyph("E", 0xE009, 190.0), Some("Ei"), None, Some("Ef")),
            glyph("Ei", 0xE00A, 200.0),
            glyph("Ef", 0xE00B, 210.0),
            with_forms(glyph("I", 0xE00C, 220.0), Some("Ii"), None, None),
            glyph("Ii", 0xE00D, 230.0),
        ]
    }

    fn join(text: &str) -> Vec<u32> {
        let (bytes, _) = compile_font(&settings(vec![]), &joining_glyphs()).unwrap();
        shape_ids(&bytes, text)
    }

    #[test]
    fn a_lone_joining_glyph_stands_alone() {
        assert_eq!(join(&A.to_string()), vec![1]);
    }

    #[test]
    fn two_joining_glyphs_take_initial_then_final() {
        assert_eq!(join(&format!("{A}{B}")), vec![3, 8]);
    }

    #[test]
    fn a_run_takes_initial_medial_final() {
        assert_eq!(join(&format!("{A}{B}{A}")), vec![3, 7, 5]);
        assert_eq!(join(&format!("{A}{B}{A}{B}")), vec![3, 7, 4, 8]);
    }

    #[test]
    fn a_glyph_that_cannot_join_breaks_the_run() {
        assert_eq!(join(&format!("{A}{B}{C}{A}{B}")), vec![3, 8, 9, 3, 8]);
        assert_eq!(join(&format!("{C}{A}{B}")), vec![9, 3, 8]);
    }

    #[test]
    fn a_space_ends_a_run() {
        let (bytes, _) = compile_font(&settings(vec![]), &joining_glyphs()).unwrap();
        let ids = shape_ids(&bytes, &format!("{A}{B} {A}{B}"));
        assert_eq!(ids[0], 3);
        assert_eq!(ids[1], 8);
        assert_eq!(ids[3], 3);
        assert_eq!(ids[4], 8);
    }

    #[test]
    fn a_glyph_missing_the_form_it_needs_stays_as_it_is_and_breaks_the_join() {
        assert_eq!(join(&format!("{A}{E}{B}")), vec![3, 10, 2]);
    }

    #[test]
    fn a_glyph_with_only_an_initial_and_final_form_works_at_the_ends() {
        assert_eq!(join(&format!("{E}{B}")), vec![11, 8]);
        assert_eq!(join(&format!("{A}{E}")), vec![3, 12]);
    }

    #[test]
    fn forms_and_rules_work_together() {
        let mut glyphs = joining_glyphs();
        glyphs.push(glyph("pair", 0xE00E, 100.0));
        let rules = vec![rule("ab", &["A"], None, None)];
        let (bytes, _) = compile_font(&settings(rules), &glyphs).unwrap();
        assert_eq!(
            shape_ids(&bytes, &format!("ab{B}"))[..],
            [3, 8],
            "ab becomes A, which then joins B"
        );
    }

    #[test]
    fn bad_forms_are_reported() {
        let mut glyphs = joining_glyphs();
        glyphs[0].meta.forms.initial = Some("nope".into());
        glyphs[1].meta.forms.medial = Some("B".into());
        let (_, issues) = plan_layout(&glyphs, &[], &inventory());
        let found: Vec<(&str, Severity)> = issues.iter().map(|i| (i.code, i.severity)).collect();
        assert!(
            found.contains(&("form-unknown-glyph", Severity::Error)),
            "{found:?}"
        );
        assert!(
            found.contains(&("form-self", Severity::Warning)),
            "{found:?}"
        );
    }

    #[test]
    fn forms_that_can_never_apply_are_reported() {
        let glyphs = vec![
            with_forms(glyph("A", 0xE000, 100.0), None, None, Some("Af")),
            glyph("Af", 0xE001, 100.0),
        ];
        let (_, issues) = plan_layout(&glyphs, &[], &inventory());
        assert!(
            issues.iter().any(|i| i.code == "form-unreachable"),
            "{issues:?}"
        );
    }

    #[test]
    fn no_forms_and_no_rules_writes_no_layout() {
        let (layout, issues) = plan_layout(&user_glyphs(), &[], &inventory());
        assert!(layout.gsub.is_none() && issues.is_empty());
    }

    #[test]
    fn a_glyph_with_only_an_initial_form_starts_a_run_but_cannot_be_joined_onto() {
        assert_eq!(
            join(&format!("{A}{I}")),
            vec![1, 13],
            "nothing to join A to"
        );
        assert_eq!(
            join(&format!("{I}{B}"))[0],
            14,
            "I starts a run when a joiner follows"
        );
        assert_eq!(join(&format!("{I}{B}"))[1], 8);
    }

    #[test]
    fn a_new_run_can_start_right_after_a_final_form() {
        assert_eq!(
            join(&format!("{A}{B}{I}{B}")),
            vec![3, 8, 14, 8],
            "A starts, B ends; I starts again and the last B ends"
        );
    }

    #[test]
    fn the_font_still_reads_back_and_keeps_its_codepoints() {
        let (bytes, report) = compile(vec![rule("ka", &["ka"], None, None)]);
        let check = crate::font::read_back(&bytes).unwrap();
        assert_eq!(check.num_glyphs as usize, 1 + 6 + report.source_glyphs);
        assert!(check.mapped.contains(&(0xE000, 1)));
        assert!(check.mapped.iter().any(|&(c, _)| c == 'k' as u32));
    }
}
