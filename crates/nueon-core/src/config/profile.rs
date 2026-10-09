//! A portable bundle of a conlang's configuration.
//!
//! Everything that describes *how* the language works — its metadata, sound
//! inventory, grammar rules and translation setup (word order, morphology,
//! affixes, table roles) — travels as one JSON document. The dictionary tables
//! themselves are the workspace, not the profile.

use serde::{Deserialize, Serialize};

use super::{GrammarConfig, LanguageConfig, PhonologyConfig, TranslationConfig};

/// Marker written into every exported profile.
pub const PROFILE_FORMAT: &str = "nueon-profile";
/// The profile schema version this build writes.
pub const PROFILE_VERSION: u32 = 2;

/// A conlang profile: its language metadata and full linguistic setup.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    /// Always [`PROFILE_FORMAT`]; used to reject unrelated JSON.
    #[serde(default)]
    pub format: String,
    /// Schema version; a newer file than this build is rejected on import.
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub language: LanguageConfig,
    #[serde(default)]
    pub phonology: PhonologyConfig,
    #[serde(default)]
    pub grammar: GrammarConfig,
    #[serde(default)]
    pub translation: TranslationConfig,
}

impl Profile {
    /// A profile with the format marker and current version filled in.
    pub fn new(
        language: LanguageConfig,
        phonology: PhonologyConfig,
        grammar: GrammarConfig,
        translation: TranslationConfig,
    ) -> Self {
        Self {
            format: PROFILE_FORMAT.to_string(),
            version: PROFILE_VERSION,
            language,
            phonology,
            grammar,
            translation,
        }
    }

    /// Whether this document looks like a profile this build can apply.
    pub fn validate(&self) -> Result<(), String> {
        if self.format != PROFILE_FORMAT {
            return Err(format!("not a nueon profile (format: {})", self.format));
        }
        if self.version > PROFILE_VERSION {
            return Err(format!(
                "profile version {} found; this app supports up to version {PROFILE_VERSION}",
                self.version
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_validates() {
        let language = LanguageConfig {
            name: "Vokala".into(),
            ..LanguageConfig::default()
        };
        let profile = Profile::new(
            language,
            PhonologyConfig::default(),
            GrammarConfig::default(),
            TranslationConfig::default(),
        );
        assert!(profile.validate().is_ok());

        let json = serde_json::to_string(&profile).unwrap();
        let back: Profile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.language.name, "Vokala");
        assert_eq!(back.format, PROFILE_FORMAT);
    }

    #[test]
    fn rejects_foreign_or_newer_documents() {
        let mut profile = Profile::new(
            LanguageConfig::default(),
            PhonologyConfig::default(),
            GrammarConfig::default(),
            TranslationConfig::default(),
        );
        profile.format = "something-else".into();
        assert!(profile.validate().is_err());

        let mut newer = Profile::new(
            LanguageConfig::default(),
            PhonologyConfig::default(),
            GrammarConfig::default(),
            TranslationConfig::default(),
        );
        newer.version = PROFILE_VERSION + 1;
        assert!(newer.validate().is_err());
    }

    #[test]
    fn accepts_v1_and_v2_but_rejects_v3() {
        let base = |version: u32| {
            let mut profile = Profile::new(
                LanguageConfig::default(),
                PhonologyConfig::default(),
                GrammarConfig::default(),
                TranslationConfig::default(),
            );
            profile.version = version;
            profile
        };
        assert!(base(1).validate().is_ok(), "a v1 profile still imports");
        assert_eq!(PROFILE_VERSION, 2);
        assert!(base(2).validate().is_ok(), "the current v2 profile imports");

        let err = base(3).validate().unwrap_err();
        assert!(err.contains('3'), "message names the found version: {err}");
        assert!(
            err.contains('2'),
            "message names the supported version: {err}"
        );
    }
}
