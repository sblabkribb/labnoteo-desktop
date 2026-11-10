//! Assistant skins (assistant spec §8): `.labnoteo-skin` packs.
//!
//! A pack is untrusted input (an imported file or a gallery download). It is
//! only ever read into memory and checked by [`pack::validate_pack`]; nothing
//! from an archive is extracted to disk by the name it carries, and every PNG
//! is decoded and re-encoded before anything else sees it. There is no command
//! that accepts pack bytes from the webview.

pub mod gallery;
pub mod pack;
pub mod store;

#[cfg(test)]
pub(crate) mod testpacks;

pub use pack::{validate_pack, Manifest, SkinError, SkinErrorKind, ValidPack};
pub use gallery::GalleryState;
pub use store::{SheetStaging, SkinData, SkinFileDialogs, SkinStaging, StagedSkin, BUILTIN_ID};
