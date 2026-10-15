//! A one-slot cache of the compiled preview font, keyed by a hash of everything the font depends on.

use std::sync::Arc;

/// The compiled bytes and the user glyph id behind each font glyph id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewFont {
    pub key: String,
    pub bytes: Arc<Vec<u8>>,
    pub glyph_ids: Arc<Vec<String>>,
}

/// Holds the last compiled preview font; a request with the same key reuses it.
#[derive(Debug, Default)]
pub struct PreviewCache {
    slot: Option<PreviewFont>,
    compiles: usize,
}

impl PreviewCache {
    /// The cached font for `key`, compiling with `build` only when the key changed.
    pub fn get_or_build<E>(
        &mut self,
        key: &str,
        build: impl FnOnce() -> Result<(Vec<u8>, Vec<String>), E>,
    ) -> Result<PreviewFont, E> {
        if let Some(font) = &self.slot {
            if font.key == key {
                return Ok(font.clone());
            }
        }
        let (bytes, ids) = build()?;
        self.compiles += 1;
        let font = PreviewFont {
            key: key.to_string(),
            bytes: Arc::new(bytes),
            glyph_ids: Arc::new(ids),
        };
        self.slot = Some(font.clone());
        Ok(font)
    }

    /// How many times a font was actually compiled.
    pub fn compiles(&self) -> usize {
        self.compiles
    }

    pub fn clear(&mut self) {
        self.slot = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn built(tag: u8) -> Result<(Vec<u8>, Vec<String>), String> {
        Ok((vec![tag], vec![String::new(), format!("g{tag}")]))
    }

    #[test]
    fn the_same_key_is_compiled_once() {
        let mut cache = PreviewCache::default();
        let a = cache.get_or_build("k1", || built(1)).unwrap();
        let b = cache.get_or_build("k1", || built(9)).unwrap();
        assert_eq!(cache.compiles(), 1);
        assert_eq!(a, b);
        assert_eq!(
            *b.bytes,
            vec![1],
            "the cached bytes are returned, not rebuilt"
        );
    }

    #[test]
    fn a_new_key_recompiles_and_replaces_the_slot() {
        let mut cache = PreviewCache::default();
        cache.get_or_build("k1", || built(1)).unwrap();
        let b = cache.get_or_build("k2", || built(2)).unwrap();
        assert_eq!(cache.compiles(), 2);
        assert_eq!(*b.bytes, vec![2]);
        cache.get_or_build("k1", || built(3)).unwrap();
        assert_eq!(
            cache.compiles(),
            3,
            "only one font is kept, so going back recompiles"
        );
    }

    #[test]
    fn a_failed_build_is_not_cached_and_is_retried() {
        let mut cache = PreviewCache::default();
        let err: Result<_, String> = cache.get_or_build("k1", || Err("boom".to_string()));
        assert!(err.is_err());
        assert_eq!(cache.compiles(), 0);
        let ok = cache.get_or_build("k1", || built(1)).unwrap();
        assert_eq!(*ok.bytes, vec![1]);
        assert_eq!(cache.compiles(), 1);
    }

    #[test]
    fn a_failed_build_keeps_the_previous_good_font() {
        let mut cache = PreviewCache::default();
        cache.get_or_build("k1", || built(1)).unwrap();
        let _ = cache.get_or_build("k2", || {
            Err::<(Vec<u8>, Vec<String>), _>("boom".to_string())
        });
        let again = cache.get_or_build("k1", || built(9)).unwrap();
        assert_eq!(*again.bytes, vec![1]);
        assert_eq!(cache.compiles(), 1, "k1 was still cached");
    }

    #[test]
    fn clear_forgets_the_font() {
        let mut cache = PreviewCache::default();
        cache.get_or_build("k1", || built(1)).unwrap();
        cache.clear();
        cache.get_or_build("k1", || built(1)).unwrap();
        assert_eq!(cache.compiles(), 2);
    }
}
