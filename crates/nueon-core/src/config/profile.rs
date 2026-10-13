//! A portable bundle of a conlang's configuration.
//!
//! Everything that describes *how* the language works — its metadata, sound
//! inventory, grammar rules and translation setup (word order, morphology,
//! affixes, table roles) — travels as one JSON document. The dictionary tables
//! themselves are the workspace, not the profile.

use serde::{Deserialize, Serialize};

use super::{GrammarConfig, LanguageConfig, PhonologyConfig, TranslationConfig, WritingConfig};

/// Marker written into every exported profile.
pub const PROFILE_FORMAT: &str = "nueon-profile";
/// The profile schema version this build writes.
pub const PROFILE_VERSION: u32 = 3;

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
    #[serde(default)]
    pub writing: WritingConfig,
}

impl Profile {
    /// A profile with the format marker and current version filled in.
    pub fn new(
        language: LanguageConfig,
        phonology: PhonologyConfig,
        grammar: GrammarConfig,
        translation: TranslationConfig,
        writing: WritingConfig,
    ) -> Self {
        Self {
            format: PROFILE_FORMAT.to_string(),
            version: PROFILE_VERSION,
            language,
            phonology,
            grammar,
            translation,
            writing,
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

    fn profile_with(language: LanguageConfig, writing: WritingConfig) -> Profile {
        Profile::new(
            language,
            PhonologyConfig::default(),
            GrammarConfig::default(),
            TranslationConfig::default(),
            writing,
        )
    }

    #[test]
    fn round_trips_and_validates() {
        let language = LanguageConfig {
            name: "Vokala".into(),
            ..LanguageConfig::default()
        };
        let profile = profile_with(language, WritingConfig::default());
        assert!(profile.validate().is_ok());

        let json = serde_json::to_string(&profile).unwrap();
        let back: Profile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.language.name, "Vokala");
        assert_eq!(back.format, PROFILE_FORMAT);
        assert_eq!(back.writing.upem, 1000);
    }

    #[test]
    fn rejects_foreign_or_newer_documents() {
        let mut profile = profile_with(LanguageConfig::default(), WritingConfig::default());
        profile.format = "something-else".into();
        assert!(profile.validate().is_err());

        let mut newer = profile_with(LanguageConfig::default(), WritingConfig::default());
        newer.version = PROFILE_VERSION + 1;
        assert!(newer.validate().is_err());
    }

    #[test]
    fn accepts_v1_v2_v3_but_rejects_v4() {
        let base = |version: u32| {
            let mut profile = profile_with(LanguageConfig::default(), WritingConfig::default());
            profile.version = version;
            profile
        };
        assert_eq!(PROFILE_VERSION, 3);
        assert!(base(1).validate().is_ok(), "a v1 profile still imports");
        assert!(base(2).validate().is_ok(), "a v2 profile still imports");
        assert!(base(3).validate().is_ok(), "the current v3 profile imports");

        let err = base(4).validate().unwrap_err();
        assert!(err.contains('4'), "message names the found version: {err}");
        assert!(
            err.contains('3'),
            "message names the supported version: {err}"
        );
    }

    #[test]
    fn v1_profile_backfills_a_default_writing_config() {
        // A v1 profile has no `writing` field; deserializing it yields the
        // default WritingConfig rather than failing.
        let json = r#"{
            "format": "nueon-profile",
            "version": 1,
            "language": { "name": "Vokala" }
        }"#;
        let profile: Profile = serde_json::from_str(json).unwrap();
        assert!(profile.validate().is_ok());
        assert_eq!(profile.writing, WritingConfig::default());
        assert_eq!(profile.writing.upem, 1000);
    }
}
