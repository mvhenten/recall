//! What a transcript reader has to know, held in one checked-in file that this crate and the
//! service both read it out of. The two read the same transcripts — a host adopting a running
//! session, and the service indexing the stretches that host sent — so a value one of them had to
//! itself is a value the session's focus line and its index could disagree over.

use serde_json::Value;

const SHARED: &str = include_str!("../../schemas/transcript-entry.json");

fn shared() -> Value {
    serde_json::from_str(SHARED).expect("schemas/transcript-entry.json parses as JSON")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string")
}

fn number(value: &Value) -> u64 {
    value.as_u64().expect("a whole number")
}

fn texts(value: &Value) -> Vec<&str> {
    value.as_array().expect("a list").iter().map(text).collect()
}

#[test]
fn the_reader_holds_what_the_shared_file_says() {
    let shared = shared();

    assert_eq!(texts(&shared["envelopes"]), crate::adopt::ENVELOPES);
    assert_eq!(text(&shared["humanOrigin"]), crate::adopt::HUMAN_ORIGIN);
    assert_eq!(texts(&shared["promptMarks"]), crate::adopt::PROMPT_MARKS);
    assert_eq!(text(&shared["sidechainMark"]), crate::adopt::SIDECHAIN_MARK);
    assert_eq!(text(&shared["mainFile"]), crate::transcripts::MAIN);
    assert_eq!(text(&shared["binaryRecord"]), crate::transcripts::BINARY_RECORD);
    assert_eq!(
        number(&shared["maxStretchBytes"]),
        crate::transcripts::MAX_APPEND_BYTES as u64
    );
    assert_eq!(number(&shared["headBytes"]), crate::adopt::HEAD as u64);
    assert_eq!(
        number(&shared["idleAfterMs"]),
        crate::sessions::IDLE_AFTER.as_millis() as u64
    );
    assert_eq!(text(&shared["globalTag"]), crate::repo::GLOBAL_TAG);
    assert_eq!(text(&shared["dashboardDevice"]), crate::listen::DASHBOARD_DEVICE);

    let name = &shared["transcriptFile"];
    assert_eq!(number(&name["maxBytes"]), crate::transcripts::NAME_MAX_BYTES as u64);
    assert_eq!(text(&name["extraChars"]), crate::transcripts::NAME_EXTRA_CHARS);
}
