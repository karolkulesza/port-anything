//! wc-lite in Rust: a port of ../ref/wc-lite.c that must behave exactly like it (same output,
//! errors and exit codes). See the reference for what it counts.

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{self, ErrorKind, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::process;

const VERSION: &str = "1.0.0";

const LINES: usize = 0;
const WORDS: usize = 1;
const CHARS: usize = 2;
const BYTES: usize = 3;
const MAXLEN: usize = 4;
const NCOUNTS: usize = 5;

/// Option letters in the order of the counts they select.
const LETTERS: &[u8] = b"lwmcL";

type Counts = [u64; NCOUNTS];

/// Exit status for a usage error.
#[cfg(not(feature = "bad-exit-code"))]
const USAGE_STATUS: i32 = 2;
// Bug: usage errors must exit 2, like the reference.
#[cfg(feature = "bad-exit-code")]
const USAGE_STATUS: i32 = 1;

fn usage(program: &str) -> String {
    format!(
        "Usage: {program} [-clmwL] [--] [FILE]...\n\
         Print line, word, character and byte counts for each FILE, and a total line\n\
         when there are several. With no FILE, or when FILE is -, read standard input.\n\
         \n\
         \x20 -c         print the byte counts\n\
         \x20 -m         print the character counts (UTF-8)\n\
         \x20 -l         print the newline counts\n\
         \x20 -w         print the word counts\n\
         \x20 -L         print the maximum line length (tabs stop every 8 columns)\n\
         \x20     --help     display this help and exit\n\
         \x20     --version  output version information and exit\n\
         \n\
         Without -c, -m, -l, -w or -L, print the line, word and byte counts.\n"
    )
}

/// The C library's message for an OS error, without the " (os error N)" Rust appends.
fn os_message(err: &io::Error) -> String {
    let text = err.to_string();
    match text.rfind(" (os error ") {
        Some(end) => text[..end].to_string(),
        None => text,
    }
}

#[cfg(not(feature = "bad-words"))]
fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}
// Bug: tabs, newlines and the other C spaces must also end a word.
#[cfg(feature = "bad-words")]
fn is_space(b: u8) -> bool {
    b == b' '
}

/// Run to run noise: the current time and process ID, never 0.
#[cfg(feature = "bad-racy")]
fn noise() -> u64 {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
    1 + (nanos ^ u64::from(process::id()).rotate_left(32)) % 1_000_000_007
}

/// Counts everything `input` holds.
fn count(input: &mut dyn Read) -> io::Result<Counts> {
    let mut buf = vec![0u8; 65536];
    let mut c: Counts = [0; NCOUNTS];
    let mut line: u64 = 0;
    let mut in_word = false;
    #[cfg(any(feature = "bad-off-by-one", feature = "bad-crlf"))]
    let mut prev: u8 = b'\n';

    loop {
        let got = match input.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        c[BYTES] += got as u64;
        for &b in &buf[..got] {
            let lead = b & 0xC0 != 0x80;
            if lead {
                c[CHARS] += 1;
            }
            if is_space(b) {
                in_word = false;
            } else if !in_word {
                in_word = true;
                c[WORDS] += 1;
            }
            if b == b'\n' {
                c[LINES] += 1;
                // Bug: a CRLF line ending must count its CR in the line length.
                #[cfg(feature = "bad-crlf")]
                if prev == b'\r' {
                    line -= 1;
                }
                c[MAXLEN] = c[MAXLEN].max(line);
                line = 0;
            } else if b == b'\t' {
                #[cfg(not(feature = "bad-rounding"))]
                {
                    line = (line / 8 + 1) * 8;
                }
                // Bug: rounds up to a tab stop, so a tab already at one (column 0, 8, …) doesn't move.
                #[cfg(feature = "bad-rounding")]
                {
                    line = (line + 7) / 8 * 8;
                }
            } else if lead {
                line += 1;
            }
            #[cfg(any(feature = "bad-off-by-one", feature = "bad-crlf"))]
            {
                prev = b;
            }
        }
    }
    // Bug: a last line without a newline must not count as a line (lines are newlines).
    #[cfg(feature = "bad-off-by-one")]
    if prev != b'\n' {
        c[LINES] += 1;
    }
    c[MAXLEN] = c[MAXLEN].max(line);
    // Bug (stands in for a data race): the maximum line length picks up a value that changes from
    // run to run, so two runs of the same case rarely agree.
    #[cfg(feature = "bad-racy")]
    {
        c[MAXLEN] += noise();
    }
    Ok(c)
}

fn print_counts(out: &mut impl Write, c: &Counts, show: &[bool; NCOUNTS], name: Option<&[u8]>) -> io::Result<()> {
    let fields: Vec<String> = (0..NCOUNTS).filter(|&k| show[k]).map(|k| format!("{:>7}", c[k])).collect();
    out.write_all(fields.join(" ").as_bytes())?;
    if let Some(name) = name {
        out.write_all(b" ")?;
        out.write_all(name)?;
    }
    out.write_all(b"\n")
}

fn run() -> io::Result<i32> {
    let args: Vec<OsString> = std::env::args_os().collect();
    let argv0 = args.first().map(|a| a.as_bytes()).unwrap_or(b"");
    let base = match argv0.iter().rposition(|&b| b == b'/') {
        Some(i) => &argv0[i + 1..],
        None => argv0,
    };
    let program = String::from_utf8_lossy(base).into_owned();
    // The name error messages start with.
    #[cfg(not(feature = "bad-program-name"))]
    let err_name = program.clone();
    // Bug: errors must name the program as it was run (argv[0]).
    #[cfg(feature = "bad-program-name")]
    let err_name = String::from("wc");
    let mut out = io::BufWriter::new(io::stdout().lock());
    let mut err = io::stderr().lock();

    let mut show = [false; NCOUNTS];
    let mut files: Vec<&OsStr> = Vec::new();
    let mut options_done = false;

    // Options may come before or after the files, up to "--".
    for arg in args.iter().skip(1) {
        let bytes = arg.as_bytes();
        if options_done || bytes.len() < 2 || bytes[0] != b'-' {
            files.push(arg);
        } else if bytes == b"--" {
            #[cfg(not(feature = "bad-double-dash"))]
            {
                options_done = true;
            }
            // Bug: after "--", arguments that look like options must be read as files.
            #[cfg(feature = "bad-double-dash")]
            {
                options_done = false;
            }
        } else if bytes[1] == b'-' {
            if bytes == b"--help" {
                out.write_all(usage(&program).as_bytes())?;
                out.flush()?;
                return Ok(0);
            }
            if bytes == b"--version" {
                writeln!(out, "wc-lite {VERSION}")?;
                out.flush()?;
                return Ok(0);
            }
            err.write_all(format!("{err_name}: unrecognized option '").as_bytes())?;
            err.write_all(bytes)?;
            err.write_all(format!("'\nTry '{err_name} --help' for more information.\n").as_bytes())?;
            return Ok(USAGE_STATUS);
        } else {
            for &letter in &bytes[1..] {
                let known = LETTERS.iter().position(|&l| l == letter);
                // Bug: -m is missing, so it is an invalid option.
                #[cfg(feature = "bad-missing-flag")]
                let known = known.filter(|_| letter != b'm');
                match known {
                    Some(k) => show[k] = true,
                    None => {
                        err.write_all(format!("{err_name}: invalid option -- '").as_bytes())?;
                        err.write_all(&[letter])?;
                        err.write_all(format!("'\nTry '{err_name} --help' for more information.\n").as_bytes())?;
                        return Ok(USAGE_STATUS);
                    }
                }
            }
        }
    }
    if !show.contains(&true) {
        show[LINES] = true;
        show[WORDS] = true;
        show[BYTES] = true;
    }

    if files.is_empty() {
        let c = match count(&mut io::stdin().lock()) {
            Ok(c) => c,
            Err(e) => {
                writeln!(err, "{err_name}: -: {}", os_message(&e))?;
                return Ok(1);
            }
        };
        print_counts(&mut out, &c, &show, None)?;
        out.flush()?;
        return Ok(0);
    }

    let mut status = 0;
    let mut total: Counts = [0; NCOUNTS];
    // Bug: the files must be read and printed in the order given.
    #[cfg(feature = "bad-ordering")]
    files.reverse();
    for name in &files {
        let name = name.as_bytes();
        let result = if name == b"-" {
            count(&mut io::stdin().lock())
        } else {
            File::open(OsStr::from_bytes(name)).and_then(|mut f| count(&mut f))
        };
        match result {
            Ok(c) => {
                print_counts(&mut out, &c, &show, Some(name))?;
                for k in 0..NCOUNTS {
                    total[k] = if k == MAXLEN { total[k].max(c[k]) } else { total[k] + c[k] };
                }
            }
            Err(e) => {
                err.write_all(format!("{err_name}: ").as_bytes())?;
                err.write_all(name)?;
                err.write_all(format!(": {}\n", os_message(&e)).as_bytes())?;
                status = 1;
            }
        }
    }
    if files.len() > 1 {
        print_counts(&mut out, &total, &show, Some(b"total"))?;
    }
    out.flush()?;
    Ok(status)
}

fn main() {
    match run() {
        Ok(status) => process::exit(status),
        Err(e) => {
            eprintln!("wc-lite: {}", os_message(&e));
            process::exit(1);
        }
    }
}
