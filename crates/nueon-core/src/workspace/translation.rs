//! Translation config, morphology and named presets.

use super::*;

impl Workspace {
    /// Add a translation preset and persist the translation config.
    pub fn add_preset(&mut self, grid: SyntaxGrid) -> Result<(), StorageError> {
        self.translation.grids.push(grid);
        storage::save_json(
            &self.config_dir().join(storage::TRANSLATION_FILE),
            &self.translation,
        )?;
        self.mark_change(Instant::now(), "nueon: update translation presets");
        Ok(())
    }

    /// Persist the translation configuration.
    pub fn save_translation(&mut self) -> Result<(), StorageError> {
        storage::save_json(
            &self.config_dir().join(storage::TRANSLATION_FILE),
            &self.translation,
        )?;
        self.mark_change(Instant::now(), "nueon: update translation presets");
        Ok(())
    }

    /// The separator and morphology rules the translation view edits.
    pub fn translation_options(&self) -> TranslationOptions {
        TranslationOptions {
            separator: self
                .translation
                .settings
                .get("word_separator")
                .cloned()
                .unwrap_or_else(|| " ".to_string()),
            affixes: self.translation.affixes.clone(),
            mode: match self.translation.settings.get("mode").map(String::as_str) {
                Some("grid") => TranslationMode::Grid,
                _ => TranslationMode::Direct,
            },
        }
    }

    /// Replace the separator and morphology rules, then persist.
    pub fn set_translation_options(
        &mut self,
        options: TranslationOptions,
    ) -> Result<(), StorageError> {
        if options.separator.is_empty() {
            self.translation.settings.remove("word_separator");
        } else {
            self.translation
                .settings
                .insert("word_separator".to_string(), options.separator);
        }
        self.translation.affixes = options.affixes;
        let mode = match options.mode {
            TranslationMode::Direct => "direct",
            TranslationMode::Grid => "grid",
        };
        self.translation
            .settings
            .insert("mode".to_string(), mode.to_string());
        self.save_translation()
    }

    /// Replace the feature paradigms, then persist.
    pub fn set_translation_morphology(
        &mut self,
        morphology: Morphology,
    ) -> Result<(), StorageError> {
        self.translation.morphology = morphology;
        self.save_translation()
    }

    /// A table's designation (vocab/fixes) and its trigger/surface columns.
    pub fn table_roles(&self) -> &BTreeMap<String, TableRoleConfig> {
        &self.translation.table_roles
    }

    /// The hand-typed affix rules together with those read from fixes tables.
    pub fn translation_affixes(&self) -> Vec<AffixRule> {
        let mut affixes = self.translation.affixes.clone();
        affixes.extend(dictionary_affixes(
            &self.dictionary,
            &self.translation.table_roles,
        ));
        affixes
    }

    /// The morphemes supplied by `Fixes` tables, for paradigm slot references.
    pub fn translation_morphemes(&self) -> Vec<Morpheme> {
        dictionary_morphemes(&self.dictionary, &self.translation.table_roles)
    }

    /// Names of tables designated `Fixes`, which supply morphemes not roots.
    pub fn fixes_tables(&self) -> BTreeSet<String> {
        self.translation
            .table_roles
            .iter()
            .filter(|(_, config)| config.role == TableRole::Fixes)
            .map(|(name, _)| name.clone())
            .collect()
    }

    /// Set a table's designation, then persist. `Vocab` with no trigger/surface
    /// removes the entry (vocab is the default).
    pub fn set_table_role(
        &mut self,
        table: &str,
        role: TableRole,
        trigger: Option<String>,
        surface: Option<String>,
    ) -> Result<bool, StorageError> {
        if self.dictionary.table(table).is_none() {
            return Ok(false);
        }
        if role == TableRole::Vocab && trigger.is_none() && surface.is_none() {
            self.translation.table_roles.remove(table);
        } else {
            self.translation.table_roles.insert(
                table.to_string(),
                TableRoleConfig {
                    role,
                    trigger,
                    surface,
                },
            );
        }
        self.save_translation()?;
        Ok(true)
    }

    /// Insert or replace a translation preset by name, then persist.
    pub fn save_preset(&mut self, grid: SyntaxGrid) -> Result<(), StorageError> {
        match self
            .translation
            .grids
            .iter_mut()
            .find(|existing| existing.preset_name == grid.preset_name)
        {
            Some(existing) => *existing = grid,
            None => self.translation.grids.push(grid),
        }
        self.save_translation()
    }

    /// Delete a translation preset by name, then persist.
    pub fn delete_preset(&mut self, name: &str) -> Result<bool, StorageError> {
        let before = self.translation.grids.len();
        self.translation
            .grids
            .retain(|grid| grid.preset_name != name);
        let removed = self.translation.grids.len() != before;
        if removed {
            self.save_translation()?;
        }
        Ok(removed)
    }

    /// The portable profile: language metadata, phonology, grammar and the
    /// translation setup, as one document.
    pub fn profile(&self) -> Profile {
        Profile::new(
            self.language.clone(),
            self.phonology.clone(),
            self.grammar.clone(),
            self.translation.clone(),
        )
    }

    /// Replace the language/phonology/grammar/translation config from a
    /// profile and persist it. Dictionary tables are left untouched.
    pub fn apply_profile(&mut self, profile: Profile) -> Result<(), StorageError> {
        self.language = profile.language;
        self.phonology = profile.phonology;
        self.grammar = profile.grammar;
        self.translation = profile.translation;
        self.save_config()
    }
}
