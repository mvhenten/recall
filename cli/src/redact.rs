//! The secrets a file holds, taken out of it before its bytes leave the host.
//!
//! Every stretch of every file goes through here on its way up, so a secret the service never
//! holds is one it cannot leak. What counts as one is a literal marker and the run of bytes that
//! may follow it — an AWS key id, a GitHub or Slack token, an Authorization header's value, a PEM
//! private key block — and never a length or a look of randomness, which would take prose with
//! it. A marker found inside a longer word is no marker at all: `task-7` is a branch, not a key.
//!
//! A match is written out as `[redacted:<kind>]`, which says what was there. That is shorter or
//! longer than what it replaced, so the file on disk and the archive of it run to different
//! lengths, and the caller carries its place in each. A placeholder is longer than most of what it
//! stands in — twenty-eight bytes for an access key id's twenty — so a stretch read to the
//! largest body the caller may send can redact to more than that, and a caller says how much it
//! can take rather than finding out from a service that refuses the body.
//!
//! A secret may sit across the cut between one stretch and the next. A stretch is cut at a line
//! end and a secret does not span lines, so the cut is almost never inside one; a PEM block does
//! span lines, and a line longer than a whole stretch is cut wherever it runs on. So a match, or a
//! marker that may yet become one, reaching the end of a stretch that is not the end of the file
//! holds the cut back to where it began, and the stretch ends short of it. One that runs past a
//! whole stretch holds the file where it is, which sends nothing rather than half a secret.
//!
//! A stretch is a run of bytes out of the middle of a file, so what reads here as its first byte
//! is a first byte of nothing: the caller hands over the byte in front of it as well, which is
//! what says whether a marker sitting there opens a word or runs on out of one. Reading offset
//! zero of a stretch as a word break would redact `xsk-...` wherever the cut fell on the `s`,
//! writing a placeholder into a record that a restore and a search both read back.

/// What one pass over a stretch wrote, and how many of the bytes it was given that accounts for.
/// The two part company where a match reaches the end of the stretch: those bytes are left to the
/// pass that can see the whole of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redacted {
    pub bytes: Vec<u8>,
    pub source: usize,
}

const OPENS: &[u8] = b"[redacted:";

fn hidden(kind: &str) -> usize {
    OPENS.len() + kind.len() + 1
}

/// A stretch as it is written out: runs of the file as they were read, and the secrets between
/// them under the names of what they were. `lead` is how much of the run in front of a secret is
/// the name that said what it was — nothing for a secret written over marker and all, and the
/// marker and what stood between for one that keeps its place in the file.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Piece<'a> {
    Kept(&'a [u8]),
    Hidden {
        kind: &'static str,
        lead: usize,
        span: usize,
    },
}

/// The stretch, redacted, and how much of it that accounts for. `before` is the byte of the file
/// just in front of the stretch, and nothing for a stretch that starts at the file's first byte.
pub fn redact(input: &[u8], before: Option<u8>, whole: bool) -> Redacted {
    within(input, before, whole, usize::MAX)
}

/// The stretch, redacted and written out to at most `limit` bytes, and how much of the stretch
/// that accounts for. A placeholder is longer than most of what it stands in, so a stretch read to
/// the largest body a caller may send can redact to more than that and the cut has to come back.
///
/// Where it comes back to is a place the rest of the file reads the same from. Nothing is cut
/// inside a placeholder, nothing between a name and the value it named — a header's scheme and a
/// registry's `_authToken=` are read in front of the run they stand for, and a stretch opening
/// past them would send that run as the prose it then looks like — and nothing out of the middle
/// of a secret written over marker and all. What is left is the runs of the file written out as
/// they were read, which a stretch may open anywhere in: the service holds a file as a run of byte
/// ranges, so a line cut in two still reads whole.
pub fn within(input: &[u8], before: Option<u8>, whole: bool, limit: usize) -> Redacted {
    let (pieces, source) = pieces(input, before, whole);
    let mut bytes = Vec::with_capacity(input.len().min(limit));
    let mut at = 0;
    for (index, piece) in pieces.iter().enumerate() {
        match piece {
            Piece::Kept(run) => {
                if run.len() > limit - bytes.len() {
                    let take = (limit - bytes.len()).min(run.len() - leading(pieces.get(index + 1)));
                    bytes.extend_from_slice(&run[..take]);
                    return Redacted {
                        bytes,
                        source: at + take,
                    };
                }
                bytes.extend_from_slice(run);
                at += run.len();
            }
            Piece::Hidden { kind, lead, span } => {
                if hidden(kind) > limit - bytes.len() {
                    bytes.truncate(bytes.len() - lead);
                    return Redacted {
                        bytes,
                        source: at - lead,
                    };
                }
                bytes.extend_from_slice(OPENS);
                bytes.extend_from_slice(kind.as_bytes());
                bytes.push(b']');
                at += span;
            }
        }
    }
    Redacted { bytes, source }
}

/// How much of the run in front of a secret named what it was, and nothing where no secret
/// follows. Those bytes go up with the secret or not at all: a stretch that ended between them
/// would leave the next one opening on a run of bytes with nothing left to say what they are.
fn leading(next: Option<&Piece<'_>>) -> usize {
    match next {
        Some(Piece::Hidden { lead, .. }) => *lead,
        _ => 0,
    }
}

/// One line of a session's own prose, redacted. A prompt is a whole line in hand rather than a
/// stretch of a file, so there is nothing in front of it and nothing left to arrive: a secret
/// pasted into one is written out as a placeholder like any other.
pub fn text(line: &str) -> String {
    String::from_utf8_lossy(&redact(line.as_bytes(), None, true).bytes).into_owned()
}

/// Where the end of an archive falls in the stretch of the file that holds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    /// A byte written out as it was read, this many bytes into the stretch.
    At(usize),
    /// Inside a placeholder, which stands for bytes the archive never held, so no place in the
    /// file answers for the end. `past` is where what the placeholder stood in ends, which is the
    /// first place a reading can carry on from without writing out the rest of a secret the
    /// archive holds the front of.
    Within { past: usize },
    /// Past everything the stretch writes out.
    Beyond,
}

/// Where in the file the archive's end falls, for an end that lands inside a stretch rather than
/// on the cut some pass made.
pub fn source_of(input: &[u8], before: Option<u8>, whole: bool, archive: usize) -> Place {
    let (pieces, _) = pieces(input, before, whole);
    let mut at = 0;
    let mut out = 0;
    for piece in pieces {
        match piece {
            Piece::Kept(run) => {
                if archive <= out + run.len() {
                    return Place::At(at + archive - out);
                }
                at += run.len();
                out += run.len();
            }
            Piece::Hidden { kind, span, .. } => {
                if archive < out + hidden(kind) {
                    return Place::Within { past: at + span };
                }
                at += span;
                out += hidden(kind);
            }
        }
    }
    Place::Beyond
}

/// The run of a stretch that is written out, piece by piece, and where it is cut.
fn pieces(input: &[u8], before: Option<u8>, whole: bool) -> (Vec<Piece<'_>>, usize) {
    let mut found = Vec::new();
    let mut kept = 0;
    let mut at = 0;
    while at < input.len() {
        match look(input, at, before, whole) {
            Look::Miss => at += 1,
            Look::Unfinished => {
                found.push(Piece::Kept(&input[kept..at]));
                return (found, at);
            }
            Look::Hit(hit) => {
                found.push(Piece::Kept(&input[kept..hit.from]));
                found.push(Piece::Hidden {
                    kind: hit.kind,
                    lead: hit.from - at,
                    span: hit.to - hit.from,
                });
                kept = hit.to;
                at = hit.to;
            }
        }
    }
    found.push(Piece::Kept(&input[kept..]));
    (found, input.len())
}

/// One secret found in a stretch: the bytes it stands in, and what it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Hit {
    from: usize,
    to: usize,
    kind: &'static str,
}

enum Look {
    Miss,
    /// A match, or a marker that may become one, reaching the end of a stretch that bytes not read
    /// yet will carry on.
    Unfinished,
    Hit(Hit),
}

/// What a marker running past the end of a stretch means: nothing where the file ends there, and
/// otherwise a cut to be held back until the rest of it has been written.
fn beyond(whole: bool) -> Look {
    if whole { Look::Miss } else { Look::Unfinished }
}

/// Whether a marker opens here, and whether the stretch holds enough of it to tell.
enum Opens {
    Yes,
    Short,
    No,
}

fn opening(input: &[u8], at: usize, marker: &[u8], folded: bool) -> Opens {
    let rest = &input[at..];
    let held = rest.len().min(marker.len());
    let same = rest[..held].iter().zip(&marker[..held]).all(|(read, want)| {
        if folded {
            read.eq_ignore_ascii_case(want)
        } else {
            read == want
        }
    });
    if !same {
        return Opens::No;
    }
    if held < marker.len() { Opens::Short } else { Opens::Yes }
}

/// How far the run of bytes `held` accepts reaches from `from`.
fn run(input: &[u8], from: usize, held: fn(u8) -> bool) -> usize {
    let mut at = from;
    while at < input.len() && held(input[at]) {
        at += 1;
    }
    at
}

/// Where `marker` next sits at or after `from`, and nothing for a stretch that does not hold it.
fn next(input: &[u8], from: usize, marker: &[u8]) -> Option<usize> {
    if from >= input.len() {
        return None;
    }
    input[from..]
        .windows(marker.len())
        .position(|run| run == marker)
        .map(|found| from + found)
}

fn upper(byte: u8) -> bool {
    byte.is_ascii_uppercase() || byte.is_ascii_digit()
}

fn plain(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
}

fn word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn dashed(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

fn based(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')
}

/// The bytes a header value or a registry token may hold, which is base64 and the URL-safe
/// alphabet a JWT is written in.
fn valued(byte: u8) -> bool {
    based(byte) || matches!(byte, b'.' | b'_' | b'~' | b'-')
}

/// What stands between a name and the value it names: the quotes, colons and escapes a header
/// reads with in JSON, in a shell line, and in a configuration file alike.
fn lead(byte: u8) -> bool {
    matches!(byte, b'"' | b'\'' | b'\\' | b':' | b'=' | b' ' | b'\t')
}

/// The bytes a PEM block is written in: base64, the dashes of its own lines, and the line ends
/// between them, escaped or not. Nothing a JSON document puts between two entries is among them,
/// so a block that is not one block is never read as one.
fn pem(byte: u8) -> bool {
    based(byte) || matches!(byte, b'-' | b':' | b',' | b'.' | b' ' | b'\t' | b'\r' | b'\n' | b'\\')
}

/// A secret written as a marker and the run that follows it. `marked` says whether the marker is
/// part of what is written over, or names a value that is and keeps its place in the file.
struct Shape {
    markers: &'static [&'static [u8]],
    folded: bool,
    marked: bool,
    held: fn(u8) -> bool,
    least: usize,
    kind: &'static str,
}

const SHAPES: &[Shape] = &[
    Shape {
        markers: &[b"AKIA", b"ASIA"],
        folded: false,
        marked: true,
        held: upper,
        least: 16,
        kind: "aws-access-key-id",
    },
    Shape {
        markers: &[b"github_pat_", b"ghp_", b"gho_", b"ghu_", b"ghs_", b"ghr_"],
        folded: false,
        marked: true,
        held: word,
        least: 20,
        kind: "github-token",
    },
    Shape {
        markers: &[b"xoxb-", b"xoxa-", b"xoxp-", b"xoxr-", b"xoxs-", b"xoxe-"],
        folded: false,
        marked: true,
        held: dashed,
        least: 10,
        kind: "slack-token",
    },
    Shape {
        markers: &[b"sk-ant-"],
        folded: false,
        marked: true,
        held: dashed,
        least: 20,
        kind: "anthropic-api-key",
    },
    Shape {
        markers: &[b"sk-proj-", b"sk-svcacct-", b"sk-admin-"],
        folded: false,
        marked: true,
        held: dashed,
        least: 20,
        kind: "openai-api-key",
    },
    // What OpenAI issued before it gave its keys a prefix each: `sk-` and then nothing but
    // letters and digits, forty of them at the least. The dashed run the prefixed keys take would
    // swallow the rest of any base64url payload holding `-sk-` or `_sk-`, which is a JWT's
    // signature as often as not, and corruption of a record is not repairable from the archive.
    Shape {
        markers: &[b"sk-"],
        folded: false,
        marked: true,
        held: plain,
        least: 40,
        kind: "openai-api-key",
    },
    Shape {
        markers: &[b"AGE-SECRET-KEY-1"],
        folded: false,
        marked: true,
        held: upper,
        least: 20,
        kind: "age-secret-key",
    },
    Shape {
        markers: &[b"_authToken="],
        folded: false,
        marked: false,
        held: valued,
        least: 8,
        kind: "npm-auth-token",
    },
];

fn shaped(input: &[u8], at: usize, whole: bool, shape: &Shape) -> Look {
    for marker in shape.markers {
        match opening(input, at, marker, shape.folded) {
            Opens::No => continue,
            Opens::Short => return beyond(whole),
            Opens::Yes => {
                let from = at + marker.len();
                let end = run(input, from, shape.held);
                if end == input.len() && !whole {
                    return Look::Unfinished;
                }
                if end - from < shape.least {
                    return Look::Miss;
                }
                return Look::Hit(Hit {
                    from: if shape.marked { at } else { from },
                    to: end,
                    kind: shape.kind,
                });
            }
        }
    }
    Look::Miss
}

/// An AWS secret access key, which is forty bytes of base64 and nothing a reader could tell from
/// any other forty. It is the name beside it that says what it is, so only a named one is a match.
fn aws_secret(input: &[u8], at: usize, whole: bool) -> Look {
    const NAMES: &[&[u8]] = &[b"aws_secret_access_key", b"aws-secret-access-key", b"secretaccesskey"];
    for name in NAMES {
        match opening(input, at, name, true) {
            Opens::No => continue,
            Opens::Short => return beyond(whole),
            Opens::Yes => {
                let named = at + name.len();
                let from = run(input, named, lead);
                if from == input.len() {
                    return beyond(whole);
                }
                if from == named {
                    return Look::Miss;
                }
                let end = run(input, from, based);
                if end == input.len() && !whole {
                    return Look::Unfinished;
                }
                if end - from < 40 {
                    return Look::Miss;
                }
                return Look::Hit(Hit {
                    from,
                    to: end,
                    kind: "aws-secret-access-key",
                });
            }
        }
    }
    Look::Miss
}

/// The value an Authorization header carries. The scheme stays as it was written: what it is
/// answers half of why a call failed, and it is no secret.
fn authorization(input: &[u8], at: usize, whole: bool) -> Look {
    const SCHEMES: &[(&[u8], &str)] = &[(b"bearer", "bearer-token"), (b"basic", "basic-credentials")];
    match opening(input, at, b"authorization", true) {
        Opens::No => return Look::Miss,
        Opens::Short => return beyond(whole),
        Opens::Yes => {}
    }
    let gap = run(input, at + b"authorization".len(), lead);
    if gap == input.len() {
        return beyond(whole);
    }
    for (scheme, kind) in SCHEMES {
        match opening(input, gap, scheme, true) {
            Opens::No => continue,
            Opens::Short => return beyond(whole),
            Opens::Yes => {
                let from = run(input, gap + scheme.len(), lead);
                if from == input.len() {
                    return beyond(whole);
                }
                let end = run(input, from, valued);
                if end == input.len() && !whole {
                    return Look::Unfinished;
                }
                if end - from < 8 {
                    return Look::Miss;
                }
                return Look::Hit(Hit { from, to: end, kind });
            }
        }
    }
    Look::Miss
}

/// How far past `-----BEGIN ` a label may run before whatever opened is not a PEM header.
const LABEL: usize = 48;

/// A PEM private key block, from its opening line through the end line that closes it. A block
/// with no end line in the stretch is not one yet: the rest of it may be bytes that have not
/// arrived, and the lines of a certificate or a public key are no secret and are left alone.
fn private_key(input: &[u8], at: usize, whole: bool) -> Look {
    const BEGIN: &[u8] = b"-----BEGIN ";
    const DASHES: &[u8] = b"-----";
    const END: &[u8] = b"-----END ";
    match opening(input, at, BEGIN, false) {
        Opens::No => return Look::Miss,
        Opens::Short => return beyond(whole),
        Opens::Yes => {}
    }
    let label = at + BEGIN.len();
    let window = (label + LABEL).min(input.len());
    let Some(head) = next(&input[..window], label, DASHES) else {
        return if window < label + LABEL {
            beyond(whole)
        } else {
            Look::Miss
        };
    };
    if !input[label..head].ends_with(b"PRIVATE KEY") {
        return Look::Miss;
    }
    let body = head + DASHES.len();
    let stop = run(input, body, pem);
    let Some(end) = next(&input[..stop], body, END).and_then(|shut| next(&input[..stop], shut + END.len(), DASHES))
    else {
        return if stop == input.len() { beyond(whole) } else { Look::Miss };
    };
    Look::Hit(Hit {
        from: at,
        to: end + DASHES.len(),
        kind: "private-key",
    })
}

/// Whether a marker may open here. A secret is a word of its own, so one found running on out of
/// another word is part of that word. The first byte of a stretch has the byte in front of it out
/// in the file rather than in hand, and a stretch of the middle of a file that read its own first
/// byte as a word break would redact wherever the cut happened to fall.
fn boundary(input: &[u8], at: usize, before: Option<u8>) -> bool {
    let prior = if at == 0 { before } else { Some(input[at - 1]) };
    !prior.is_some_and(|byte| byte.is_ascii_alphanumeric())
}

fn look(input: &[u8], at: usize, before: Option<u8>, whole: bool) -> Look {
    if !boundary(input, at, before) {
        return Look::Miss;
    }
    for shape in SHAPES {
        match shaped(input, at, whole, shape) {
            Look::Miss => continue,
            found => return found,
        }
    }
    for find in [aws_secret, authorization, private_key] {
        match find(input, at, whole) {
            Look::Miss => continue,
            found => return found,
        }
    }
    Look::Miss
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stripped(text: &str) -> String {
        String::from_utf8(redact(text.as_bytes(), None, true).bytes).unwrap()
    }

    #[test]
    fn every_pattern_the_reader_knows_is_written_out_under_the_name_of_what_it_was() {
        assert_eq!(
            stripped("aws_access_key_id = AKIAZZ7EXAMPLE9QTVB2\n"),
            "aws_access_key_id = [redacted:aws-access-key-id]\n"
        );
        assert_eq!(
            stripped("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n"),
            "aws_secret_access_key = [redacted:aws-secret-access-key]\n"
        );
        assert_eq!(
            stripped("{\"secretAccessKey\":\"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\"}"),
            "{\"secretAccessKey\":\"[redacted:aws-secret-access-key]\"}"
        );
        assert_eq!(
            stripped("token ghp_3kQ9fakeTOKENvalue0000000000000000 here"),
            "token [redacted:github-token] here"
        );
        assert_eq!(
            stripped("github_pat_11AFAKE0000000000000000_abcdefghijklmnop"),
            "[redacted:github-token]"
        );
        assert_eq!(
            stripped("xoxb-FAKE-FAKE-nothing-real-in-here"),
            "[redacted:slack-token]"
        );
        assert_eq!(
            stripped("sk-ant-api03-fake00000000000000000000"),
            "[redacted:anthropic-api-key]"
        );
        assert_eq!(
            stripped("sk-proj-fake000000000000000000000"),
            "[redacted:openai-api-key]"
        );
        assert_eq!(
            stripped("AGE-SECRET-KEY-1FAKE000000000000000000000000"),
            "[redacted:age-secret-key]"
        );
        assert_eq!(
            stripped("//registry.example.com/:_authToken=fake-token-0000"),
            "//registry.example.com/:_authToken=[redacted:npm-auth-token]"
        );
        assert_eq!(
            stripped("curl -H 'Authorization: Bearer eyJfake.payload.signature' https://example.com"),
            "curl -H 'Authorization: Bearer [redacted:bearer-token]' https://example.com"
        );
        assert_eq!(
            stripped("{\"authorization\": \"Basic ZmFrZTpjcmVkZW50aWFscw==\"}"),
            "{\"authorization\": \"Basic [redacted:basic-credentials]\"}"
        );
        assert_eq!(
            stripped("-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZQ==\nfake\n-----END OPENSSH PRIVATE KEY-----\n"),
            "[redacted:private-key]\n"
        );
        assert_eq!(
            stripped("\"key\":\"-----BEGIN RSA PRIVATE KEY-----\\nZmFrZQ==\\n-----END RSA PRIVATE KEY-----\\n\""),
            "\"key\":\"[redacted:private-key]\\n\""
        );
    }

    /// A marker running on out of a word, with a run behind it long enough to clear every floor
    /// a shape sets. Each of these redacts the moment the word break in front of the marker is
    /// read wrong, so the rule is what keeps them whole and never their length.
    const WORDS: &[(&str, &str)] = &[
        ("git switch task-7AKIAZZ7EXAMPLE9QTVB2-rebased\n", "AKIAZZ7"),
        ("the file myghp_3kQ9fakeTOKENvalue0000000000000000.json\n", "ghp_3kQ9"),
        ("xsk-abcdefghijklmnopqrstuvwxyz0123456789abcdef\n", "sk-abcdef"),
    ];

    #[test]
    fn what_a_session_writes_about_its_own_work_is_left_alone() {
        for prose in [
            "git switch task-redaction-and-tool-results-work\n",
            "the branch fix/sk-work is not a key\n",
            "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n",
            "-----BEGIN PUBLIC KEY-----\nZmFrZQ==\n-----END PUBLIC KEY-----\n",
            "AKIA is the prefix an access key id opens with\n",
            "export AWS_SECRET_ACCESS_KEY=$(pass show aws)\n",
            "Authorization: Bearer $TOKEN\n",
            "a ghp_ token is a GitHub one\n",
        ] {
            assert_eq!(stripped(prose), prose, "prose a session wrote about secrets is not one");
        }
        for (prose, _) in WORDS {
            assert_eq!(
                stripped(prose),
                *prose,
                "a marker running on out of a word is part of that word, however long the run behind it"
            );
        }
    }

    #[test]
    fn a_marker_at_the_head_of_a_stretch_is_read_against_the_byte_in_front_of_it() {
        for (prose, marker) in WORDS {
            let bytes = prose.as_bytes();
            let at = prose.find(marker).expect("every one of these holds its marker");
            let tail = &bytes[at..];
            let before = bytes[at - 1];

            assert_eq!(
                String::from_utf8(redact(tail, Some(before), true).bytes).unwrap(),
                String::from_utf8_lossy(tail),
                "a stretch cut at {at} opens inside a word, which the byte in front of it says"
            );
            assert_ne!(
                String::from_utf8(redact(tail, None, true).bytes).unwrap(),
                String::from_utf8_lossy(tail),
                "and the same bytes read as the start of a file are a secret, which is why the byte is passed"
            );
        }
    }

    #[test]
    fn a_base64url_payload_holding_sk_is_left_alone_rather_than_eaten_from_there_on() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.aGVsbG8-sk-9zdGVyZWRfYnl0ZXNfaGVyZQ.c2lnbmF0dXJl";

        assert_eq!(
            stripped(jwt),
            jwt,
            "a JWT is not an OpenAI key, and taking the rest of one is corruption no reader can repair"
        );
        assert_eq!(
            stripped("sk-proj-fake000000000000000000000"),
            "[redacted:openai-api-key]",
            "the prefixes OpenAI issues are still read"
        );
        assert_eq!(
            stripped("sk-FAKE0000000000000000000000000000000000fake"),
            "[redacted:openai-api-key]",
            "and so is the unprefixed shape, at the forty bytes it runs to"
        );
    }

    #[test]
    fn a_secret_across_the_cut_between_two_stretches_holds_the_cut_back_to_where_it_began() {
        let line = b"before ghp_3kQ9fakeTOKENvalue0000000000000000 after";
        let whole = String::from_utf8(redact(line, None, true).bytes).unwrap();
        for cut in 1..line.len() {
            let head = redact(&line[..cut], None, false);
            let before = head.source.checked_sub(1).map(|at| line[at]);
            let mut sent = head.bytes.clone();
            sent.extend_from_slice(&redact(&line[head.source..], before, true).bytes);
            assert_eq!(
                String::from_utf8(sent).unwrap(),
                whole,
                "a stretch cut at {cut} and the rest of the line read after it"
            );
            assert!(
                !String::from_utf8(head.bytes).unwrap().contains("ghp_3kQ9"),
                "no part of the token goes up under a cut at {cut}"
            );
        }
    }

    #[test]
    fn a_stretch_the_file_ends_in_writes_out_everything_it_holds() {
        let line = b"before ghp_3kQ9fakeTOKENvalue0000000000000000 after";
        for cut in 1..=line.len() {
            let head = redact(&line[..cut], None, true);
            assert_eq!(
                head.source, cut,
                "a pass told the file ends here holds nothing back, at a cut at {cut}"
            );
        }
        assert_eq!(
            stripped("before ghp_3kQ9fakeTOKEN"),
            "before ghp_3kQ9fakeTOKEN",
            "and a marker with too short a run behind it is prose, which is what a file ending there holds"
        );
    }

    #[test]
    fn a_pem_block_across_the_cut_waits_for_the_line_that_closes_it() {
        let block = b"-----BEGIN RSA PRIVATE KEY-----\nZmFrZQ==\nZmFrZQ==\n-----END RSA PRIVATE KEY-----\n";
        let head = redact(&block[..60], None, false);

        assert_eq!(head.source, 0, "a block with no end line yet sends none of itself");
        assert_eq!(
            String::from_utf8(redact(block, None, false).bytes).unwrap(),
            "[redacted:private-key]\n",
            "and the pass that holds the whole block writes it out as one"
        );
    }

    #[test]
    fn where_the_archive_ends_is_a_place_in_the_file_unless_it_falls_inside_a_secret() {
        let line = b"id AKIAZZ7EXAMPLE9QTVB2 end\n";
        let archive = redact(line, None, true).bytes;

        assert_eq!(source_of(line, None, true, 0), Place::At(0));
        assert_eq!(
            source_of(line, None, true, 3),
            Place::At(3),
            "a byte sent as it was read is its own place"
        );
        assert_eq!(
            source_of(line, None, true, 3 + hidden("aws-access-key-id")),
            Place::At(3 + "AKIAZZ7EXAMPLE9QTVB2".len()),
            "the end of a placeholder is the end of what it stood in"
        );
        assert_eq!(
            source_of(line, None, true, 3 + hidden("aws-access-key-id") - 1),
            Place::Within {
                past: 3 + "AKIAZZ7EXAMPLE9QTVB2".len()
            },
            "and a place inside one is no place in the file, which the end of what it stood in is"
        );
        assert_eq!(source_of(line, None, true, archive.len()), Place::At(line.len()));
        assert_eq!(source_of(line, None, true, archive.len() + 1), Place::Beyond);
    }

    #[test]
    fn a_stretch_written_out_to_a_length_is_cut_where_the_rest_of_it_reads_the_same_from() {
        let line = "id AKIAZZ7EXAMPLE9QTVB2 and Authorization: Bearer abcdefghijklmnop end\n";
        let whole = stripped(line);
        for limit in 1..=whole.len() {
            let head = within(line.as_bytes(), None, true, limit);
            assert!(head.bytes.len() <= limit, "a stretch written out to {limit} fits in it");
            assert!(head.source <= line.len());

            let before = head.source.checked_sub(1).map(|at| line.as_bytes()[at]);
            let mut sent = head.bytes.clone();
            sent.extend_from_slice(&redact(&line.as_bytes()[head.source..], before, true).bytes);
            assert_eq!(
                String::from_utf8(sent).unwrap(),
                whole,
                "the stretch after one cut at {limit} carries on where it left off"
            );
        }
    }

    #[test]
    fn a_prompt_a_key_was_pasted_into_carries_a_placeholder_rather_than_the_key() {
        assert_eq!(
            text("use ghp_3kQ9fakeTOKENvalue0000000000000000 for the push"),
            "use [redacted:github-token] for the push"
        );
        assert_eq!(text("find the redaction bug"), "find the redaction bug");
    }
}
