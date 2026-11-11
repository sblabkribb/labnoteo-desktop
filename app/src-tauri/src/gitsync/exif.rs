//! Photo location check (spec §6.3): does a JPEG or TIFF carry an EXIF GPS
//! IFD (tag 0x8825)? A small, bounds-checked reader that only walks IFD0 and
//! the GPS IFD it points to. It never panics, never loops, and never reads
//! past the slice, whatever the bytes are.

/// The EXIF tag that points to the GPS IFD.
const GPS_IFD_TAG: u16 = 0x8825;

/// The GPS IFD tag `GPSVersionID`, which a camera with location turned off
/// may still write on its own.
const GPS_VERSION_TAG: u16 = 0x0000;

/// True when the bytes are a JPEG (APP1 `Exif\0\0`) or a TIFF whose IFD0
/// points to a GPS IFD that holds anything besides the version. A pointer
/// that cannot be followed still counts as location data (the warning is
/// cheap; a missed location is not).
pub fn has_gps(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xFF, 0xD8]) {
        return jpeg_has_gps(bytes);
    }
    tiff_has_gps(bytes)
}

fn jpeg_has_gps(bytes: &[u8]) -> bool {
    let mut i = 2usize;
    loop {
        // Every marker starts with 0xFF; any number of fill bytes may precede it.
        if bytes.get(i) != Some(&0xFF) {
            return false;
        }
        while bytes.get(i) == Some(&0xFF) {
            i += 1;
        }
        let Some(&marker) = bytes.get(i) else { return false };
        i += 1;
        match marker {
            // End of image, start of scan: no metadata after this point.
            0xD9 | 0xDA => return false,
            // Standalone markers carry no length.
            0x01 | 0xD0..=0xD7 => continue,
            _ => {}
        }
        let Some(len) = be16(bytes, i) else { return false };
        let len = usize::from(len);
        if len < 2 {
            return false;
        }
        let Some(end) = i.checked_add(len).filter(|&e| e <= bytes.len()) else { return false };
        let data = &bytes[i + 2..end];
        if marker == 0xE1 {
            if let Some(tiff) = data.strip_prefix(b"Exif\0\0") {
                if tiff_has_gps(tiff) {
                    return true;
                }
            }
        }
        i = end;
    }
}

#[derive(Clone, Copy)]
enum Order {
    Little,
    Big,
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    let s = b.get(at..at.checked_add(2)?)?;
    Some(u16::from_be_bytes([s[0], s[1]]))
}

fn read16(b: &[u8], at: usize, o: Order) -> Option<u16> {
    let s = b.get(at..at.checked_add(2)?)?;
    Some(match o {
        Order::Little => u16::from_le_bytes([s[0], s[1]]),
        Order::Big => u16::from_be_bytes([s[0], s[1]]),
    })
}

fn read32(b: &[u8], at: usize, o: Order) -> Option<u32> {
    let s = b.get(at..at.checked_add(4)?)?;
    let a = [s[0], s[1], s[2], s[3]];
    Some(match o {
        Order::Little => u32::from_le_bytes(a),
        Order::Big => u32::from_be_bytes(a),
    })
}

/// The entries of the IFD at `off`: `(tag, value field offset)`. `None` when
/// the IFD does not fit in the slice.
fn ifd_entries(t: &[u8], off: usize, o: Order) -> Option<Vec<(u16, usize)>> {
    let count = usize::from(read16(t, off, o)?);
    let first = off.checked_add(2)?;
    let end = first.checked_add(count.checked_mul(12)?)?;
    if end > t.len() {
        return None;
    }
    Some((0..count).map(|k| first + 12 * k).filter_map(|e| Some((read16(t, e, o)?, e + 8))).collect())
}

fn tiff_has_gps(t: &[u8]) -> bool {
    let order = match t.get(0..4) {
        Some(b"II*\0") => Order::Little,
        Some(b"MM\0*") => Order::Big,
        _ => return false,
    };
    let Some(ifd0) = read32(t, 4, order) else { return false };
    let Some(entries) = ifd_entries(t, ifd0 as usize, order) else { return false };
    let Some(&(_, value_at)) = entries.iter().find(|(tag, _)| *tag == GPS_IFD_TAG) else { return false };
    let Some(gps_off) = read32(t, value_at, order) else { return true };
    match ifd_entries(t, gps_off as usize, order) {
        Some(gps) => gps.iter().any(|(tag, _)| *tag != GPS_VERSION_TAG),
        None => true,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A little-endian TIFF: IFD0 with an `Orientation` entry and, when
    /// `gps` is set, a GPS IFD pointer to an IFD holding GPSVersionID and
    /// GPSLatitudeRef.
    fn tiff(gps: bool, big: bool) -> Vec<u8> {
        let w16 = |v: u16| if big { v.to_be_bytes() } else { v.to_le_bytes() };
        let w32 = |v: u32| if big { v.to_be_bytes() } else { v.to_le_bytes() };
        let mut t: Vec<u8> = Vec::new();
        t.extend_from_slice(if big { b"MM\0*" } else { b"II*\0" });
        t.extend_from_slice(&w32(8));
        let n: u16 = if gps { 2 } else { 1 };
        t.extend_from_slice(&w16(n));
        // Orientation = 1 (SHORT, count 1).
        t.extend_from_slice(&w16(0x0112));
        t.extend_from_slice(&w16(3));
        t.extend_from_slice(&w32(1));
        t.extend_from_slice(&w16(1));
        t.extend_from_slice(&[0, 0]);
        let gps_at = 8 + 2 + 12 * u32::from(n) + 4;
        if gps {
            t.extend_from_slice(&w16(GPS_IFD_TAG));
            t.extend_from_slice(&w16(4));
            t.extend_from_slice(&w32(1));
            t.extend_from_slice(&w32(gps_at));
        }
        t.extend_from_slice(&w32(0)); // no next IFD
        if gps {
            assert_eq!(t.len() as u32, gps_at);
            t.extend_from_slice(&w16(2));
            // GPSVersionID: BYTE x4 = 2.3.0.0
            t.extend_from_slice(&w16(0x0000));
            t.extend_from_slice(&w16(1));
            t.extend_from_slice(&w32(4));
            t.extend_from_slice(&[2, 3, 0, 0]);
            // GPSLatitudeRef: ASCII "N\0"
            t.extend_from_slice(&w16(0x0001));
            t.extend_from_slice(&w16(2));
            t.extend_from_slice(&w32(2));
            t.extend_from_slice(&[b'N', 0, 0, 0]);
            t.extend_from_slice(&w32(0));
        }
        t
    }

    /// A minimal JPEG: SOI, an APP0 (JFIF), APP1 Exif with `tiff`, SOS, EOI.
    pub(crate) fn jpeg(gps: bool) -> Vec<u8> {
        let mut j = vec![0xFF, 0xD8];
        let jfif = b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0";
        j.extend_from_slice(&[0xFF, 0xE0]);
        j.extend_from_slice(&((jfif.len() + 2) as u16).to_be_bytes());
        j.extend_from_slice(jfif);
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend_from_slice(&tiff(gps, false));
        j.extend_from_slice(&[0xFF, 0xE1]);
        j.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
        j.extend_from_slice(&app1);
        j.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02, 0x12, 0x34, 0xFF, 0xD9]);
        j
    }

    #[test]
    fn a_jpeg_with_a_gps_ifd_has_gps() {
        assert!(has_gps(&jpeg(true)));
    }

    #[test]
    fn a_jpeg_without_a_gps_ifd_has_none() {
        assert!(!has_gps(&jpeg(false)));
    }

    #[test]
    fn tiff_in_both_byte_orders() {
        assert!(has_gps(&tiff(true, false)));
        assert!(has_gps(&tiff(true, true)));
        assert!(!has_gps(&tiff(false, false)));
        assert!(!has_gps(&tiff(false, true)));
    }

    #[test]
    fn a_gps_ifd_with_only_the_version_is_not_location() {
        let mut t = tiff(true, false);
        // Drop GPSLatitudeRef: the GPS IFD count becomes 1.
        let gps_at = 8 + 2 + 12 * 2 + 4;
        t[gps_at] = 1;
        assert!(!has_gps(&t));
    }

    #[test]
    fn a_gps_pointer_out_of_range_still_counts() {
        let mut t = tiff(true, false);
        t.truncate(8 + 2 + 12 * 2 + 4);
        assert!(has_gps(&t));
    }

    #[test]
    fn non_images_have_no_gps() {
        assert!(!has_gps(b""));
        assert!(!has_gps(b"\x89PNG\r\n\x1a\n"));
        assert!(!has_gps(b"hello"));
        assert!(!has_gps(&[0xFF, 0xD8]));
        assert!(!has_gps(&[0xFF, 0xD8, 0xFF, 0xE1, 0x00]));
    }

    /// Fixed-seed xorshift64: the same 1,000 slices every run.
    struct XorShift(u64);
    impl XorShift {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
    }

    #[test]
    fn random_bytes_never_panic() {
        let mut rng = XorShift(0x9E37_79B9_7F4A_7C15);
        let seeds = [jpeg(true), jpeg(false), tiff(true, false), tiff(true, true)];
        for n in 0..1000 {
            let len = (rng.next() % 600) as usize;
            let mut b: Vec<u8> = (0..len).map(|_| rng.next() as u8).collect();
            match n % 4 {
                // Pure noise, then noise behind each header, then mutated valid files.
                0 => {}
                1 => b.splice(0..0, [0xFF, 0xD8, 0xFF, 0xE1]).for_each(drop),
                2 => b.splice(0..0, *b"II*\0").for_each(drop),
                _ => {
                    b = seeds[(rng.next() % 4) as usize].clone();
                    for _ in 0..(1 + rng.next() % 6) {
                        let at = (rng.next() as usize) % b.len();
                        b[at] = rng.next() as u8;
                    }
                    let cut = (rng.next() as usize) % (b.len() + 1);
                    b.truncate(cut);
                }
            }
            let _ = has_gps(&b);
        }
    }
}
