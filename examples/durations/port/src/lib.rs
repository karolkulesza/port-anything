//! dur in Rust: a port of ../ref/dur.c that must behave exactly like it. See ../ref/dur.h for
//! the format: an optional `-` and parts such as `1h30m`.

use std::fmt::Write;

/// Why `parse` refused its input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    /// `""` or a lone `-`.
    Empty,
    /// A part without digits before its unit.
    BadNumber,
    /// Digits followed by something other than `d`, `h`, `m` or `s`.
    BadUnit,
    /// The total doesn't fit in an `i64`.
    Overflow,
}

/// Units from the largest down, in seconds.
const UNITS: [(char, u64); 4] = [('d', 86400), ('h', 3600), ('m', 60), ('s', 1)];

fn unit_seconds(unit: u8) -> Option<u64> {
    UNITS.iter().find(|(c, _)| *c as u8 == unit).map(|&(_, seconds)| seconds)
}

/// The total of a duration such as `1h30m` or `-2d`, in seconds.
pub fn parse(text: &str) -> Result<i64, ParseError> {
    let (negative, mut rest) = match text.as_bytes() {
        [b'-', rest @ ..] => (true, rest),
        bytes => (false, bytes),
    };
    if rest.is_empty() {
        return Err(ParseError::Empty);
    }
    // The magnitude, up to i64::MAX, or one more when negative (i64::MIN).
    let limit = if negative { i64::MAX as u64 + 1 } else { i64::MAX as u64 };
    let mut total: u64 = 0;
    while !rest.is_empty() {
        let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        if digits == 0 {
            return Err(ParseError::BadNumber);
        }
        let mut n: u64 = 0;
        let mut overflow = false;
        for &b in &rest[..digits] {
            match n.checked_mul(10).and_then(|v| v.checked_add(u64::from(b - b'0'))).filter(|&v| v <= limit) {
                Some(v) => n = v,
                None => overflow = true,
            }
        }
        let unit = rest.get(digits).copied().and_then(unit_seconds).ok_or(ParseError::BadUnit)?;
        rest = &rest[digits + 1..];
        if cfg!(feature = "bad-overflow") {
            total = total.wrapping_add(n.wrapping_mul(unit));
            continue;
        }
        if overflow || n > (limit - total) / unit {
            return Err(ParseError::Overflow);
        }
        total += n * unit;
    }
    // total <= limit, so it fits, and 2^63 negated wraps to i64::MIN as it should.
    Ok(if negative { (total as i64).wrapping_neg() } else { total as i64 })
}

/// `seconds` as parts from days down to seconds, zero parts left out: `1h30m`, `-2d`, `0s`.
pub fn format(seconds: i64) -> String {
    let mut out = String::new();
    if seconds < 0 {
        out.push('-');
    }
    let mut rest = seconds.unsigned_abs();
    if rest == 0 {
        out.push_str("0s");
    }
    for (unit, size) in UNITS {
        let n = rest / size;
        rest %= size;
        if n > 0 {
            write!(out, "{n}{unit}").unwrap();
        }
    }
    out
}

