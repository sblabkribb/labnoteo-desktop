//! Test fixtures for `pack.rs`: well-formed and malicious `.labnoteo-skin`
//! archives built in memory. Nothing here touches the disk.
//!
//! Most malformed archives cannot be produced by the `zip` writer (it refuses
//! duplicate names, writes honest sizes, never sets the encryption flag), so
//! [`raw_zip`] writes the local headers, central directory and end record by
//! hand from [`RawEntry`] values that may lie about anything.

use std::io::{Cursor, Read, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// The built-in Flasko skin, exactly as shipped in `app/public/skins/flasko`.
pub fn flasko_files() -> Vec<(String, Vec<u8>)> {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../public/skins/flasko/");
    ["manifest.json", "idle.png", "talk.png", "think.png", "done.png"]
        .iter()
        .map(|n| (n.to_string(), std::fs::read(format!("{dir}{n}")).expect("flasko asset")))
        .collect()
}

/// The Flasko manifest as JSON, to be edited by a test.
pub fn flasko_manifest() -> serde_json::Value {
    let files = flasko_files();
    serde_json::from_slice(&files[0].1).unwrap()
}

/// One sheet of Flasko by file name.
pub fn flasko_sheet(name: &str) -> Vec<u8> {
    flasko_files().into_iter().find(|(n, _)| n == name).expect("sheet").1
}

/// A zip written by the `zip` writer (honest headers).
pub fn zip_with(entries: &[(&str, &[u8])], method: CompressionMethod) -> Vec<u8> {
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(method).unix_permissions(0o644);
    for (name, data) in entries {
        w.start_file(*name, opts).unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

/// Flasko zipped by the `zip` writer, with `manifest` in place of its manifest.
pub fn flasko_pack_with(manifest: &serde_json::Value) -> Vec<u8> {
    let m = serde_json::to_vec_pretty(manifest).unwrap();
    let files = flasko_files();
    let mut entries: Vec<(&str, &[u8])> = vec![("manifest.json", &m)];
    for (n, d) in files.iter().skip(1) {
        entries.push((n.as_str(), d.as_slice()));
    }
    zip_with(&entries, CompressionMethod::Deflated)
}

/// Flasko zipped as shipped.
pub fn flasko_pack() -> Vec<u8> {
    let files = flasko_files();
    let entries: Vec<(&str, &[u8])> = files.iter().map(|(n, d)| (n.as_str(), d.as_slice())).collect();
    zip_with(&entries, CompressionMethod::Deflated)
}

/// A central-directory entry whose every field is chosen by the test.
#[derive(Clone)]
pub struct RawEntry {
    pub name: Vec<u8>,
    /// 0 = Stored, 8 = Deflated, anything else = unsupported.
    pub method: u16,
    /// General-purpose flags (bit 0 = encrypted).
    pub flags: u16,
    /// The bytes stored in the archive (already compressed for method 8).
    pub data: Vec<u8>,
    /// CRC-32 of the uncompressed data.
    pub crc: u32,
    /// The uncompressed size the headers declare.
    pub size: u32,
    /// High byte: host system (3 = Unix); low byte: spec version.
    pub made_by: u16,
    /// External attributes (Unix mode in the high 16 bits).
    pub ext_attr: u32,
}

impl RawEntry {
    /// An honest Stored entry with a regular-file Unix mode.
    pub fn stored(name: &str, data: &[u8]) -> RawEntry {
        RawEntry::stored_bytes(name.as_bytes(), data)
    }

    pub fn stored_bytes(name: &[u8], data: &[u8]) -> RawEntry {
        RawEntry {
            name: name.to_vec(),
            method: 0,
            flags: 0,
            data: data.to_vec(),
            crc: crc32(data),
            size: data.len() as u32,
            made_by: (3 << 8) | 20,
            ext_attr: 0o100644 << 16,
        }
    }

    /// An honest Deflated entry.
    pub fn deflated(name: &str, data: &[u8]) -> RawEntry {
        RawEntry {
            method: 8,
            data: deflate(data),
            ..RawEntry::stored(name, data)
        }
    }
}

/// Flasko as honest Stored raw entries (manifest first).
pub fn flasko_raw() -> Vec<RawEntry> {
    flasko_files().iter().map(|(n, d)| RawEntry::stored(n, d)).collect()
}

/// Writes local headers, data, central directory and the end record.
pub fn raw_zip(entries: &[RawEntry]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut offsets = Vec::new();
    for e in entries {
        offsets.push(out.len() as u32);
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&e.flags.to_le_bytes());
        out.extend_from_slice(&e.method.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0x21u16.to_le_bytes());
        out.extend_from_slice(&e.crc.to_le_bytes());
        out.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&e.size.to_le_bytes());
        out.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&e.name);
        out.extend_from_slice(&e.data);
    }
    let cd_start = out.len() as u32;
    for (e, off) in entries.iter().zip(&offsets) {
        out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        out.extend_from_slice(&e.made_by.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&e.flags.to_le_bytes());
        out.extend_from_slice(&e.method.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0x21u16.to_le_bytes());
        out.extend_from_slice(&e.crc.to_le_bytes());
        out.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&e.size.to_le_bytes());
        out.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra
        out.extend_from_slice(&0u16.to_le_bytes()); // comment
        out.extend_from_slice(&0u16.to_le_bytes()); // disk
        out.extend_from_slice(&0u16.to_le_bytes()); // internal attributes
        out.extend_from_slice(&e.ext_attr.to_le_bytes());
        out.extend_from_slice(&off.to_le_bytes());
        out.extend_from_slice(&e.name);
    }
    let cd_size = out.len() as u32 - cd_start;
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_start.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// Raw deflate stream of `data` (taken out of a one-entry zip).
pub fn deflate(data: &[u8]) -> Vec<u8> {
    let z = zip_with(&[("x", data)], CompressionMethod::Deflated);
    let mut a = ZipArchive::new(Cursor::new(z)).unwrap();
    let mut f = a.by_index_raw(0).unwrap();
    let mut out = Vec::new();
    f.read_to_end(&mut out).unwrap();
    out
}

/// Bitwise CRC-32 (IEEE), as used by zip and PNG.
pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for b in data {
        c ^= *b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
        }
    }
    !c
}

/// An RGBA PNG of the given size with a simple pattern.
pub fn png_rgba(w: u32, h: u32) -> Vec<u8> {
    let mut px = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            px.extend_from_slice(&[(x * 7) as u8, (y * 5) as u8, ((x + y) * 3) as u8, if (x + y) % 3 == 0 { 0 } else { 255 }]);
        }
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().unwrap();
        wr.write_image_data(&px).unwrap();
        wr.finish().unwrap();
    }
    out
}

/// Builds one PNG chunk (length, type, data, CRC).
pub fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut c = Vec::new();
    c.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut body = kind.to_vec();
    body.extend_from_slice(data);
    c.extend_from_slice(&body);
    c.extend_from_slice(&crc32(&body).to_be_bytes());
    c
}

/// `png` with `chunks` inserted right after IHDR (signature 8 + IHDR 25 bytes).
pub fn insert_after_ihdr(png: &[u8], chunks: &[Vec<u8>]) -> Vec<u8> {
    let mut out = png[..33].to_vec();
    for c in chunks {
        out.extend_from_slice(c);
    }
    out.extend_from_slice(&png[33..]);
    out
}

/// The chunk types of a PNG in file order.
pub fn chunk_types(png: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 8;
    while i + 8 <= png.len() {
        let len = u32::from_be_bytes(png[i..i + 4].try_into().unwrap()) as usize;
        out.push(String::from_utf8_lossy(&png[i + 4..i + 8]).into_owned());
        i += 12 + len;
    }
    out
}
