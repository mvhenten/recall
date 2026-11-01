use crate::api::Message;
use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as Frame;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_tls_with_config};

pub const PING_INTERVAL: Duration = Duration::from_secs(30);
pub const CLOSE_REVOKED: u16 = 4001;

pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug)]
pub enum Incoming {
    Message(Box<Message>),
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

pub fn ack(message_id: &str) -> String {
    serde_json::json!({ "type": "ack", "messageId": message_id }).to_string()
}

pub fn parse_frame(raw: &str) -> Result<Incoming> {
    let frame: Value = serde_json::from_str(raw).context("the mailbox sent a frame that is not JSON")?;
    if frame.get("type").and_then(Value::as_str) != Some("message") {
        return Ok(Incoming::Ignored);
    }
    let body = frame.get("message").cloned().unwrap_or(Value::Null);
    let message: Message = serde_json::from_value(body).context("the mailbox sent a message frame it cannot read")?;
    Ok(Incoming::Message(Box::new(message)))
}

pub fn listen_request(url: &str, token: &str) -> Result<Request> {
    let mut request = url
        .into_client_request()
        .with_context(|| format!("{url} is not a WebSocket URL"))?;
    let authorization = format!("Bearer {token}")
        .parse()
        .context("the device token holds a character an HTTP header cannot carry; run recall login")?;
    request.headers_mut().insert("authorization", authorization);
    Ok(request)
}

pub async fn connect(url: &str, token: &str) -> Result<Socket> {
    let (socket, _) = connect_async_tls_with_config(listen_request(url, token)?, None, false, None)
        .await
        .with_context(|| format!("connecting to {url}"))?;
    Ok(socket)
}

/// Reads the mailbox until it closes, handing every message to `on_message` and acking it
/// afterwards. A message that cannot be delivered is acked all the same: the mailbox has no
/// other host to hand it to, so redelivery would only replay it into the same silence.
pub async fn pump(socket: &mut Socket, mut on_message: impl AsyncFnMut(Message)) -> Result<Ended> {
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
                let Incoming::Message(message) = parse_frame(&text)? else {
                    continue;
                };
                let message_id = message.message_id.clone();
                on_message(*message).await;
                socket
                    .send(Frame::text(ack(&message_id)))
                    .await
                    .context("acking a message")?;
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
    use tokio::net::TcpListener;

    const MESSAGE: &str = r#"{"type":"message","message":{"messageId":"m-1","toDeviceId":"d-here","fromDeviceId":"d-there","body":"ship it","createdAt":1,"expiresAt":2}}"#;

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

    #[tokio::test]
    async fn every_message_the_mailbox_pushes_is_acked() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            socket.send(Frame::text(r#"{"type":"hello"}"#)).await.unwrap();
            socket.send(Frame::text(MESSAGE)).await.unwrap();
            let reply = socket.next().await.unwrap().unwrap().into_text().unwrap().to_string();
            socket.close(None).await.unwrap();
            reply
        });

        let mut socket = connect(&format!("ws://127.0.0.1:{port}/v1/messages/listen"), "t-token")
            .await
            .unwrap();
        let mut delivered = Vec::new();
        let ended = pump(&mut socket, async |message: Message| delivered.push(message.body))
            .await
            .unwrap();

        assert!(matches!(ended, Ended::Closed));
        assert_eq!(delivered, vec!["ship it"]);
        let reply: Value = serde_json::from_str(&server.await.unwrap()).unwrap();
        assert_eq!(reply, serde_json::json!({ "type": "ack", "messageId": "m-1" }));
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
        let ended = pump(&mut socket, async |_: Message| ()).await.unwrap();
        assert!(matches!(ended, Ended::Revoked));
    }
}
