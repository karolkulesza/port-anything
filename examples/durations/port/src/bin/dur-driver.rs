//! dur-driver in Rust: the port's command-line driver, which must answer every call exactly like
//! ../ref/driver.c answers it for the reference. One call per line on stdin, one JSON result per
//! line on stdout:
//!
//! ```text
//! {"fn":"parse","args":["1h30m"]}  ->  {"ok":5400}
//! {"fn":"format","args":[5400]}    ->  {"ok":"1h30m"}
//! {"fn":"parse","args":["1x"]}     ->  {"error":"bad-unit"}
//! ```
//!
//! A line that isn't a call it knows, in exactly this compact form, gives `{"error":"bad-call"}`.
//! Strings may hold printable ASCII and the escapes `\"` and `\\`. A real driver would use
//! serde_json; this one has no dependencies, so the example builds offline.

use std::io::{self, BufWriter, Read, Write};

use dur::ParseError;

/// The longest function name and string argument the C driver takes (its buffers, less the NUL).
const MAX_FN: usize = 15;
const MAX_TEXT: usize = 4095;

enum Arg {
    Text(String),
    Int(i64),
}

/// Reads one call; None for anything else.
fn read_call(line: &[u8]) -> Option<(String, Arg)> {
    let rest = line.strip_prefix(b"{\"fn\":\"")?;
    let len = rest.iter().take_while(|b| b.is_ascii_lowercase()).count();
    if len == 0 || len > MAX_FN {
        return None;
    }
    let name = String::from_utf8(rest[..len].to_vec()).ok()?;
    let mut rest = rest[len..].strip_prefix(b"\",\"args\":[")?;
    let arg = if let Some(after) = rest.strip_prefix(b"\"") {
        let mut text = String::new();
        let mut i = 0;
        loop {
            let mut b = *after.get(i)?;
            if b == b'"' {
                break;
            }
            if b == b'\\' {
                i += 1;
                b = *after.get(i)?;
                if b != b'"' && b != b'\\' {
                    return None;
                }
            } else if !(0x20..=0x7e).contains(&b) {
                return None;
            }
            if text.len() == MAX_TEXT {
                return None;
            }
            text.push(b as char);
            i += 1;
        }
        rest = &after[i + 1..];
        Arg::Text(text)
    } else {
        let sign = usize::from(rest.first() == Some(&b'-'));
        let digits = rest[sign..].iter().take_while(|b| b.is_ascii_digit()).count();
        if digits == 0 {
            return None;
        }
        let n = std::str::from_utf8(&rest[..sign + digits]).ok()?.parse().ok()?;
        rest = &rest[sign + digits..];
        Arg::Int(n)
    };
    (rest == b"]}").then_some((name, arg))
}

fn error_name(error: ParseError) -> &'static str {
    match error {
        ParseError::Empty => "empty",
        ParseError::BadNumber => "bad-number",
        ParseError::BadUnit => "bad-unit",
        ParseError::Overflow => "overflow",
    }
}

fn main() -> io::Result<()> {
    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input)?;
    let mut lines: Vec<&[u8]> = input.split(|&b| b == b'\n').collect();
    if lines.last() == Some(&&b""[..]) {
        lines.pop(); // after the last newline
    }
    let mut out = BufWriter::new(io::stdout().lock());
    for line in lines {
        match read_call(line) {
            Some((name, Arg::Text(text))) if name == "parse" => match dur::parse(&text) {
                Ok(seconds) => writeln!(out, "{{\"ok\":{seconds}}}")?,
                Err(error) => writeln!(out, "{{\"error\":\"{}\"}}", error_name(error))?,
            },
            Some((name, Arg::Int(n))) if name == "format" => writeln!(out, "{{\"ok\":\"{}\"}}", dur::format(n))?,
            _ => writeln!(out, "{{\"error\":\"bad-call\"}}")?,
        }
    }
    out.flush()
}
