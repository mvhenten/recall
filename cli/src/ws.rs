use crate::api::Message;
use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as Frame;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_tls_with_config};

pub const PING_INTERVAL: Duration = Duration::from_secs(30);
pub const CLOSE_REVOKED: u16 = 4001;

/// What this daemon declares on the upgrade: it reads a message's kind, so an order it is handed
/// goes to one of its sessions. A mailbox hands no order to a socket that declares nothing, since a
/// daemon too old to read the kind would write the order into every session it has.
pub const ORDERS_HEADER: &str = "x-recall-orders";

pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// `token` is the claim the mailbox handed this socket along with an order, and the receipt has to
/// quote it back. News answers nothing, so it arrives under an empty claim.
#[derive(Debug)]
pub enum Incoming {
    Message { message: Box<Message>, token: String },
    Ignored,
}

pub enum Ended {
    Closed,
    Revoked,
}

pub fn listen_url(endpoint: &str) -> Result<String> {
    let endpoint = endpoint.trim_end_matches('/');
    let Some((scheme, rest)) = endpoint.split_once("://") else {
        bail!("{endpoint} is not a URL; run recall login --endpoint https://<your recall host>");
    };
    let scheme = match scheme {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        other => bail!("{other}:// is not a recall endpoint; use https://<your recall host>"),
    };
    Ok(format!("{scheme}://{rest}/v1/messages/listen"))
}

/// What this host writes back about an order: the session that took it, or that it has no session
/// that could. Both are sent the moment the host knows, so a sender never waits out the window for
/// an answer the host already has. News is never answered at all — the bus's obligation ends at
/// the push, and nothing on the service is waiting to hear about it.
#[derive(Debug, PartialEq, Eq)]
pub enum Reply {
    Took(String),
    NoTaker,
}

pub fn receipt(message_id: &str, token: &str, reply: &Reply) -> String {
    match reply {
        Reply::Took(session_id) => serde_json::json!({
            "type": "took",
            "messageId": message_id,
            "sessionId": session_id,
            "token": token,
        })
        .to_string(),
        Reply::NoTaker => serde_json::json!({ "type": "none", "messageId": message_id, "token": token }).to_string(),
    }
}

pub fn parse_frame(raw: &str) -> Result<Incoming> {
    let frame: Value = serde_json::from_str(raw).context("the mailbox sent a frame that is not JSON")?;
    if frame.get("type").and_then(Value::as_str) != Some("message") {
        return Ok(Incoming::Ignored);
    }
    let token = frame
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let body = frame.get("message").cloned().unwrap_or(Value::Null);
    let message: Message = serde_json::from_value(body).context("the mailbox sent a message frame it cannot read")?;
    Ok(Incoming::Message {
        message: Box::new(message),
        token,
    })
}

pub fn listen_request(url: &str, token: &str) -> Result<Request> {
    let mut request = url
        .into_client_request()
        .with_context(|| format!("{url} is not a WebSocket URL"))?;
    let authorization = format!("Bearer {token}")
        .parse()
        .context("the device token holds a character an HTTP header cannot carry; run recall login")?;
    request.headers_mut().insert("authorization", authorization);
    request
        .headers_mut()
        .insert(ORDERS_HEADER, HeaderValue::from_static("1"));
    Ok(request)
}

pub async fn connect(url: &str, token: &str) -> Result<Socket> {
    let (socket, _) = connect_async_tls_with_config(listen_request(url, token)?, None, false, None)
        .await
        .with_context(|| format!("connecting to {url}"))?;
    Ok(socket)
}

/// Reads the mailbox until it closes, handing every message to `on_message` and writing back the
/// receipt it asks for, quoting the claim the message arrived under. News asks for none.
pub async fn pump(socket: &mut Socket, mut on_message: impl AsyncFnMut(Message) -> Option<Reply>) -> Result<Ended> {
    let mut heartbeat = tokio::time::interval(PING_INTERVAL);
    heartbeat.tick().await;
    let mut silent = false;
    loop {
        let frame = tokio::select! {
            _ = heartbeat.tick() => {
                if silent {
                    return Ok(Ended::Closed);
                }
                socket.send(Frame::Ping(Default::default())).await.context("sending a heartbeat")?;
                silent = true;
                continue;
            }
            frame = socket.next() => frame,
        };
        let Some(frame) = frame else { return Ok(Ended::Closed) };
        silent = false;
        match frame.context("reading from the mailbox")? {
            Frame::Text(text) => {
                let Incoming::Message { message, token } = parse_frame(&text)? else {
                    continue;
                };
                let message_id = message.message_id.clone();
                let Some(reply) = on_message(*message).await else {
                    continue;
                };
                socket
                    .send(Frame::text(receipt(&message_id, &token, &reply)))
                    .await
                    .context("reporting on an order")?;
            }
            Frame::Close(Some(close)) if u16::from(close.code) == CLOSE_REVOKED => return Ok(Ended::Revoked),
            Frame::Close(_) => return Ok(Ended::Closed),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Kind;
    use tokio::net::TcpListener;

    const MESSAGE: &str = r#"{"type":"message","token":"","message":{"messageId":"m-1","toDeviceId":"d-here","toSessionId":"","fromDeviceId":"d-there","body":"ship it","createdAt":1}}"#;
    const ORDER: &str = r#"{"type":"message","token":"t-order","message":{"messageId":"m-2","kind":"order","toDeviceId":"d-here","toSessionId":"","fromDeviceId":"d-there","body":"rerun the migration","createdAt":1}}"#;

    #[test]
    fn the_endpoint_becomes_the_listen_url() {
        assert_eq!(
            listen_url("https://recall.test/").unwrap(),
            "wss://recall.test/v1/messages/listen"
        );
        assert_eq!(
            listen_url("http://127.0.0.1:8787").unwrap(),
            "ws://127.0.0.1:8787/v1/messages/listen"
        );
        assert!(listen_url("recall.test").unwrap_err().to_string().contains("not a URL"));
    }

    #[test]
    fn a_frame_that_is_not_a_message_is_ignored() {
        assert!(matches!(parse_frame(r#"{"type":"hello"}"#).unwrap(), Incoming::Ignored));
        let error = parse_frame(r#"{"type":"message","message":{}}"#)
            .unwrap_err()
            .to_string();
        assert!(error.contains("cannot read"), "{error}");
    }

    #[test]
    fn the_tls_config_tokio_tungstenite_builds_finds_a_crypto_provider() {
        rustls::ClientConfig::builder()
            .with_root_certificates(rustls::RootCertStore::empty())
            .with_no_client_auth();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[test]
    fn the_upgrade_carries_the_device_token_the_api_client_sends() {
        let request = listen_request("wss://recall.test/v1/messages/listen", "t-token").unwrap();
        assert_eq!(request.headers().get("authorization").unwrap(), "Bearer t-token");
    }

    #[test]
    fn the_upgrade_declares_that_this_daemon_reads_the_kind_of_a_message() {
        let request = listen_request("wss://recall.test/v1/messages/listen", "t-token").unwrap();
        assert_eq!(request.headers().get(ORDERS_HEADER).unwrap(), "1");
    }

    /// Only an order is answered. News reaches the sessions that were listening and that is the end
    /// of it, so a host that wrote a receipt for one would have the mailbox close the socket.
    #[tokio::test]
    async fn news_reaches_the_sessions_and_writes_nothing_back() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            socket.send(Frame::text(r#"{"type":"hello"}"#)).await.unwrap();
            socket.send(Frame::text(MESSAGE)).await.unwrap();
            let answered = tokio::time::timeout(Duration::from_millis(250), socket.next()).await;
            socket.close(None).await.unwrap();
            answered.is_ok()
        });

        let mut socket = connect(&format!("ws://127.0.0.1:{port}/v1/messages/listen"), "t-token")
            .await
            .unwrap();
        let mut delivered = Vec::new();
        let ended = pump(&mut socket, async |message: Message| {
            delivered.push(message.body);
            None
        })
        .await
        .unwrap();

        assert!(matches!(ended, Ended::Closed));
        assert_eq!(delivered, vec!["ship it"]);
        assert!(!server.await.unwrap(), "news writes no receipt back");
    }

    /// An order is answered either way and at once: the session that took it, or that none could.
    /// A host that went quiet on the second would leave the sender waiting out the window the
    /// service gives an order before reporting a failure it already knows about.
    #[tokio::test]
    async fn an_order_names_the_session_that_took_it_or_says_none_did() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            socket.send(Frame::text(ORDER)).await.unwrap();
            socket.send(Frame::text(ORDER)).await.unwrap();
            let mut replies = Vec::new();
            while let Some(frame) = socket.next().await {
                let Ok(Frame::Text(text)) = frame else { break };
                replies.push(text.to_string());
                if replies.len() == 2 {
                    break;
                }
            }
            socket.close(None).await.unwrap();
            replies
        });

        let mut socket = connect(&format!("ws://127.0.0.1:{port}/v1/messages/listen"), "t-token")
            .await
            .unwrap();
        let mut answered = 0;
        pump(&mut socket, async |message: Message| {
            assert!(matches!(message.kind, Kind::Order));
            answered += 1;
            Some(match answered {
                1 => Reply::Took("s-9f8a".to_string()),
                _ => Reply::NoTaker,
            })
        })
        .await
        .unwrap();

        let replies: Vec<Value> = server
            .await
            .unwrap()
            .iter()
            .map(|reply| serde_json::from_str(reply).unwrap())
            .collect();
        assert_eq!(
            replies,
            vec![
                serde_json::json!({ "type": "took", "messageId": "m-2", "sessionId": "s-9f8a", "token": "t-order" }),
                serde_json::json!({ "type": "none", "messageId": "m-2", "token": "t-order" }),
            ]
        );
    }

    #[tokio::test]
    async fn a_revoked_device_is_told_to_sign_in_again() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            socket
                .send(Frame::Close(Some(
                    tokio_tungstenite::tungstenite::protocol::CloseFrame {
                        code: CLOSE_REVOKED.into(),
                        reason: "revoked".into(),
                    },
                )))
                .await
                .unwrap();
        });

        let mut socket = connect(&format!("ws://127.0.0.1:{port}/v1/messages/listen"), "t-token")
            .await
            .unwrap();
        let ended = pump(&mut socket, async |_: Message| None).await.unwrap();
        assert!(matches!(ended, Ended::Revoked));
    }
}
