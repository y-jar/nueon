//! Build a folder tree from the workspace's note paths.

use std::path::{Component, Path, PathBuf};

use crate::workspace::NoteFile;

/// A node in the notes tree (folder or note).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct NoteNode {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub children: Vec<NoteNode>,
}

/// Build a tree rooted at an empty node, folders first then files.
pub(crate) fn build(notes: &[NoteFile]) -> NoteNode {
    let mut root = NoteNode::default();
    for note in notes {
        insert(&mut root, &note.path);
    }
    sort(&mut root);
    root
}

fn insert(root: &mut NoteNode, path: &Path) {
    let components: Vec<&std::ffi::OsStr> = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part),
            _ => None,
        })
        .collect();
    let last = components.len().saturating_sub(1);

    let mut node = root;
    for (index, part) in components.iter().enumerate() {
        let name = part.to_string_lossy().into_owned();
        let is_dir = index != last;
        let existing = node
            .children
            .iter()
            .position(|child| child.name == name && child.is_dir == is_dir);
        let child_index = match existing {
            Some(index) => index,
            None => {
                let mut child_path = node.path.clone();
                child_path.push(part);
                node.children.push(NoteNode {
                    name,
                    path: child_path,
                    is_dir,
                    children: Vec::new(),
                });
                node.children.len() - 1
            }
        };
        node = &mut node.children[child_index];
    }
}

fn sort(node: &mut NoteNode) {
    node.children.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    for child in &mut node.children {
        sort(child);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notes(paths: &[&str]) -> Vec<NoteFile> {
        paths.iter().map(|path| NoteFile::new(*path, "")).collect()
    }

    #[test]
    fn builds_folders_first() {
        let tree = build(&notes(&[
            "overview",
            "Grammar/phonology",
            "Grammar/syntax",
            "Culture/notes",
        ]));
        let names: Vec<&str> = tree.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Culture", "Grammar", "overview"]);

        let grammar = &tree.children[1];
        assert!(grammar.is_dir);
        let grammar_children: Vec<&str> =
            grammar.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(grammar_children, ["phonology", "syntax"]);
        assert_eq!(grammar.children[0].path, PathBuf::from("Grammar/phonology"));
    }
}
