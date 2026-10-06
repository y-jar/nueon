//! Etymology helpers: parent candidates and rename/delete propagation plans.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::dictionary::Dictionary;

/// A planned rename of one word.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenameTarget {
    pub table: String,
    pub id: Uuid,
    pub old_name: String,
    pub new_name: String,
}

/// A word related to a change (a child or descendant).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelatedWord {
    pub table: String,
    pub id: Uuid,
    pub wordname: String,
}

/// A node in the derivation graph: a word plus its parents within the graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DerivationNode {
    pub id: Uuid,
    pub table: String,
    pub wordname: String,
    /// Parent ids that are also present in the graph.
    pub parents: Vec<Uuid>,
}

/// The self + ancestor + descendant subgraph around `id`, for visualisation.
///
/// `parents` on each node are restricted to ids also present in the returned
/// set, so the frontend can render a nested tree without dangling edges.
pub fn graph(dict: &Dictionary, id: Uuid) -> Vec<DerivationNode> {
    if dict.find_entry(id).is_none() {
        return Vec::new();
    }

    let mut ids: Vec<Uuid> = vec![id];
    for ancestor in dict.ancestors_of(id) {
        if !ids.contains(&ancestor.id) {
            ids.push(ancestor.id);
        }
    }
    for descendant in dict.descendants_of(id) {
        if !ids.contains(&descendant.id) {
            ids.push(descendant.id);
        }
    }

    let present: HashSet<Uuid> = ids.iter().copied().collect();
    ids.into_iter()
        .filter_map(|uid| {
            dict.find_entry(uid).map(|(table, entry)| DerivationNode {
                id: entry.id,
                table: table.to_string(),
                wordname: entry.wordname.clone(),
                parents: entry
                    .parents()
                    .into_iter()
                    .filter(|parent| present.contains(parent))
                    .collect(),
            })
        })
        .collect()
}

/// Words that may legally become a parent of `child_id`.
///
/// Excludes the word itself, its descendants (which would create a cycle),
/// and parents it already has.
pub fn parent_candidates(dict: &Dictionary, child_id: Uuid) -> Vec<RelatedWord> {
    let mut excluded: HashSet<Uuid> = dict
        .descendants_of(child_id)
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    excluded.insert(child_id);
    let existing: HashSet<Uuid> = dict.parents_of(child_id).into_iter().collect();

    let mut out = Vec::new();
    for table in dict.tables() {
        for entry in &table.entries {
            if !excluded.contains(&entry.id) && !existing.contains(&entry.id) {
                out.push(RelatedWord {
                    table: table.name.clone(),
                    id: entry.id,
                    wordname: entry.wordname.clone(),
                });
            }
        }
    }
    out
}

/// Direct children that reference `id` (affected by deleting it).
pub fn direct_children(dict: &Dictionary, id: Uuid) -> Vec<RelatedWord> {
    let mut out = Vec::new();
    for table in dict.tables() {
        for entry in &table.entries {
            if entry.parents().contains(&id) {
                out.push(RelatedWord {
                    table: table.name.clone(),
                    id: entry.id,
                    wordname: entry.wordname.clone(),
                });
            }
        }
    }
    out
}

/// Every descendant of `id`.
pub fn descendants(dict: &Dictionary, id: Uuid) -> Vec<RelatedWord> {
    dict.descendants_of(id)
        .into_iter()
        .filter_map(|entry| {
            dict.find_entry(entry.id).map(|(table, found)| RelatedWord {
                table: table.to_string(),
                id: found.id,
                wordname: found.wordname.clone(),
            })
        })
        .collect()
}

/// Every ancestor of `id`.
pub fn ancestors(dict: &Dictionary, id: Uuid) -> Vec<RelatedWord> {
    dict.ancestors_of(id)
        .into_iter()
        .filter_map(|entry| {
            dict.find_entry(entry.id).map(|(table, found)| RelatedWord {
                table: table.to_string(),
                id: found.id,
                wordname: found.wordname.clone(),
            })
        })
        .collect()
}

/// Plan substring renames for every descendant whose name contains `old`.
pub fn plan_substring_rename(
    dict: &Dictionary,
    id: Uuid,
    old: &str,
    new: &str,
) -> Vec<RenameTarget> {
    if old.is_empty() {
        return Vec::new();
    }
    descendants(dict, id)
        .into_iter()
        .filter_map(|related| {
            related.wordname.contains(old).then(|| RenameTarget {
                table: related.table,
                id: related.id,
                new_name: related.wordname.replace(old, new),
                old_name: related.wordname,
            })
        })
        .collect()
}

/// Apply a planned rename.
pub fn apply_rename(dict: &mut Dictionary, targets: &[RenameTarget]) {
    for target in targets {
        if let Some(entry) = dict.get_entry_mut(&target.table, target.id) {
            entry.wordname = target.new_name.clone();
        }
    }
}

/// Remove `id` from its direct children's parent lists.
pub fn unlink_from_children(dict: &mut Dictionary, id: Uuid) {
    for child in direct_children(dict, id) {
        if let Some(entry) = dict.get_entry_mut(&child.table, child.id) {
            entry.remove_parent(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::WordEntry;

    fn build() -> (Dictionary, Uuid, Uuid, Uuid, Uuid) {
        let mut dict = Dictionary::new();
        dict.add_table("all words");

        let root = WordEntry::new("kala");
        let root_id = root.id;
        dict.add_entry("all words", root);

        let mut child_a = WordEntry::new("kalator");
        let child_a_id = child_a.id;
        child_a.add_parent(root_id);
        dict.add_entry("all words", child_a);

        let mut child_b = WordEntry::new("velo");
        let child_b_id = child_b.id;
        child_b.add_parent(root_id);
        dict.add_entry("all words", child_b);

        let mut grandchild = WordEntry::new("kalator-mini");
        let grandchild_id = grandchild.id;
        grandchild.add_parent(child_a_id);
        dict.add_entry("all words", grandchild);

        (dict, root_id, child_a_id, child_b_id, grandchild_id)
    }

    #[test]
    fn parent_candidates_exclude_self_descendants_and_existing() {
        let (dict, root_id, child_a, _child_b, grandchild) = build();
        let candidates: Vec<Uuid> = parent_candidates(&dict, child_a)
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert!(!candidates.contains(&child_a));
        assert!(!candidates.contains(&root_id), "existing parent excluded");
        assert!(!candidates.contains(&grandchild), "descendant excluded");
    }

    #[test]
    fn cycle_guard_rejects_self_and_descendants() {
        let (dict, root_id, child_a, _child_b, grandchild) = build();
        assert!(!dict.can_be_parent(child_a, child_a));
        assert!(!dict.can_be_parent(root_id, grandchild));
        assert!(dict.can_be_parent(child_a, root_id));
    }

    #[test]
    fn rename_plan_only_touches_matching_descendants() {
        let (dict, root_id, _a, _b, grandchild) = build();
        let plan = plan_substring_rename(&dict, root_id, "kala", "kalo");
        assert_eq!(plan.len(), 2, "kalator and kalator-mini match");
        assert!(plan
            .iter()
            .any(|t| t.id == grandchild && t.new_name == "kalotor-mini"));
    }

    #[test]
    fn delete_unlinks_direct_children_only() {
        let (mut dict, root_id, child_a, child_b, grandchild) = build();
        dict.remove_entry("all words", root_id);
        unlink_from_children(&mut dict, root_id);

        assert!(!dict.get_entry("all words", child_a).unwrap().has_parent());
        assert!(!dict.get_entry("all words", child_b).unwrap().has_parent());
        assert_eq!(
            dict.get_entry("all words", grandchild).unwrap().parents(),
            vec![child_a]
        );
    }

    #[test]
    fn graph_contains_ancestors_descendants_and_local_edges() {
        let (dict, root_id, child_a, _child_b, grandchild) = build();
        let nodes = graph(&dict, child_a);
        let by_id = |id: Uuid| nodes.iter().find(|node| node.id == id).unwrap();

        assert_eq!(nodes.len(), 3, "root, a, grandchild");
        assert!(by_id(root_id).parents.is_empty());
        assert_eq!(by_id(child_a).parents, vec![root_id]);
        assert_eq!(by_id(grandchild).parents, vec![child_a]);
        assert!(graph(&dict, Uuid::new_v4()).is_empty());
    }
}
