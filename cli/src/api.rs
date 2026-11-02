use crate::config::Config;
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use ureq::http::Response;
use ureq::{Agent, RequestBuilder};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub memory_id: String,
    pub user_id: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub body: String,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub recall_count: i64,
    pub last_recalled_at: i64,
}

#[derive(Debug, Serialize)]
pub struct SaveBody<'a> {
    pub description: &'a str,
    #[serde(rename = "type")]
    pub kind: &'a str,
    pub body: &'a str,
    pub tags: &'a [String],
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub memory: Memory,
    pub created: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Hit {
    pub score: f64,
    pub memory: Memory,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub memories: Vec<Memory>,
    pub next_cursor: String,
}

#[derive(Deserialize)]
struct Single {
    memory: Memory,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub hits: Vec<Hit>,
    #[serde(default)]
    pub elsewhere: Vec<Elsewhere>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Elsewhere {
    pub score: f64,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub tags: Vec<String>,
    pub description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest<'a> {
    pub query: &'a str,
    pub tags: &'a [String],
    pub any: bool,
    pub limit: u32,
    pub min_score: f64,
    pub mode: &'a str,
}

pub struct Client {
    agent: Agent,
    config: Config,
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn check(mut response: Response<ureq::Body>, what: &str) -> Result<Response<ureq::Body>> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let text = response.body_mut().read_to_string().unwrap_or_default();
    if status.is_server_error() {
        bail!(
            "{what} failed: the recall service had an error ({status}): {}",
            text.trim()
        );
    }
    let hint = match status.as_u16() {
        300..=399 => "; Cloudflare Access redirected the call, check RECALL_ENDPOINT",
        401 | 403 => "; run recall login",
        _ => "",
    };
    bail!("{what} failed with {status}: {}{hint}", text.trim())
}

fn agent() -> Agent {
    Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(5)))
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into()
}

#[derive(Debug, Deserialize)]
pub struct DeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Deserialize)]
struct GrantError {
    error: String,
    #[serde(default)]
    error_description: String,
}

#[derive(Deserialize)]
struct Granted {
    access_token: String,
}

pub enum Poll {
    Granted(String),
    Pending,
    SlowDown,
    Denied,
    Expired,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub device_id: String,
    pub name: String,
    pub created_at: i64,
    pub last_used_at: i64,
    pub current: bool,
}

#[derive(Deserialize)]
struct Devices {
    devices: Vec<Device>,
}

/// `to_session_id` is the one session the message is addressed to, or empty for every session the
/// host has registered.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub message_id: String,
    pub to_device_id: String,
    pub to_session_id: String,
    pub from_device_id: String,
    pub body: String,
    pub created_at: i64,
    pub expires_at: i64,
}

#[derive(Deserialize)]
struct Sent {
    message: Message,
}

/// One Claude Code session on one of the hosts signed in as this user, as the service holds it.
/// `name` is the handle `recall send` takes to reach this one session, so the listing doubles as
/// an address book.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub session_id: String,
    pub name: String,
    pub device_id: String,
    pub host: String,
    pub cwd: String,
    pub repo: String,
    pub branch: String,
    pub commit: String,
    pub started_at: i64,
    pub last_activity_at: i64,
    pub prompts: i64,
    pub focus: crate::sessions::Focus,
    pub mode: String,
    pub permission_mode: String,
    pub pid: i64,
    pub current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBody<'a> {
    pub host: &'a str,
    pub cwd: &'a str,
    pub repo: &'a str,
    pub branch: &'a str,
    pub commit: &'a str,
    pub started_at: i64,
    pub last_activity_at: i64,
    pub prompts: i64,
    pub focus: &'a crate::sessions::Focus,
    pub mode: &'a str,
    pub permission_mode: &'a str,
    pub pid: i64,
}

/// One usage delta. `host` and `repo` ride along rather than being read from the session row, so
/// a session that already ended still has its closing tokens counted under the host that spent
/// them.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBody<'a> {
    pub host: &'a str,
    pub repo: &'a str,
    #[serde(flatten)]
    pub event: &'a crate::sessions::UsageEvent,
}

#[derive(Deserialize)]
struct Sessions {
    sessions: Vec<Session>,
}

/// The device a message is queued against, and the one session on it the message is for; an empty
/// `session_id` reaches every session that host has registered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub device_id: String,
    pub session_id: String,
}

/// `to` is a device id or device name, which reaches every session on that host, or a session
/// handle or session id, which reaches that one session. A device answers first, so `sessions` is
/// called only for a target no device claims and an ordinary host send costs no listing.
pub fn resolve_target(devices: &[Device], sessions: impl FnOnce() -> Result<Vec<Session>>, to: &str) -> Result<Target> {
    let host = |device_id: &str| {
        Ok(Target {
            device_id: device_id.to_string(),
            session_id: String::new(),
        })
    };
    if devices.iter().any(|device| device.device_id == to) {
        return host(to);
    }
    if let Some(device) = devices.iter().find(|device| device.name == to) {
        return host(&device.device_id);
    }
    let listed = sessions()?;
    let addressed: Vec<&Session> = listed
        .iter()
        .filter(|session| session.name == to || session.session_id == to)
        .collect();
    match addressed.as_slice() {
        [session] => Ok(Target {
            device_id: session.device_id.clone(),
            session_id: session.session_id.clone(),
        }),
        [] => bail!(
            "no host or session named {to}; recall devices lists the hosts signed in as you and recall sessions the handle of each live session"
        ),
        many => {
            let ids: Vec<&str> = many.iter().map(|session| session.session_id.as_str()).collect();
            bail!(
                "ambiguous target {to}: {} sessions answer to it; pass one of these session ids instead: {}",
                many.len(),
                ids.join(", ")
            )
        }
    }
}

pub struct DeviceLogin {
    agent: Agent,
    endpoint: String,
}

impl DeviceLogin {
    pub fn new(endpoint: &str) -> DeviceLogin {
        DeviceLogin {
            agent: agent(),
            endpoint: endpoint.trim_end_matches('/').to_string(),
        }
    }

    pub fn start(&self, device_name: &str) -> Result<DeviceStart> {
        let response = self
            .agent
            .post(format!("{}/v1/device/code", self.endpoint))
            .send_json(serde_json::json!({ "device_name": device_name }))?;
        Ok(check(response, "starting the device login")?.body_mut().read_json()?)
    }

    pub fn poll(&self, device_code: &str) -> Result<Poll> {
        let mut response = self
            .agent
            .post(format!("{}/v1/device/token", self.endpoint))
            .send_json(serde_json::json!({
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code,
            }))?;
        if response.status().as_u16() == 400 {
            let grant: GrantError = response.body_mut().read_json()?;
            return match grant.error.as_str() {
                "authorization_pending" => Ok(Poll::Pending),
                "slow_down" => Ok(Poll::SlowDown),
                "access_denied" => Ok(Poll::Denied),
                "expired_token" => Ok(Poll::Expired),
                _ => bail!("the device login failed: {} {}", grant.error, grant.error_description),
            };
        }
        let granted: Granted = check(response, "finishing the device login")?.body_mut().read_json()?;
        Ok(Poll::Granted(granted.access_token))
    }
}

impl Client {
    pub fn new(config: Config) -> Client {
        Client { agent: agent(), config }
    }

    fn authed<B>(&self, request: RequestBuilder<B>) -> RequestBuilder<B> {
        request.header("authorization", format!("Bearer {}", self.config.token))
    }

    pub fn devices(&self) -> Result<Vec<Device>> {
        let response = self.authed(self.agent.get(self.url("/v1/devices"))).call()?;
        let devices: Devices = check(response, "listing devices")?.body_mut().read_json()?;
        Ok(devices.devices)
    }

    pub fn revoke_device(&self, device_id: &str) -> Result<bool> {
        let response = self
            .authed(
                self.agent
                    .delete(self.url(&format!("/v1/devices/{}", encode(device_id)))),
            )
            .call()?;
        if response.status().as_u16() == 404 {
            return Ok(false);
        }
        check(response, &format!("revoking device {device_id}"))?;
        Ok(true)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.config.endpoint)
    }

    fn memory_path(name: &str) -> String {
        format!("/v1/memories/{}", encode(name))
    }

    pub fn save(&self, name: &str, body: &SaveBody) -> Result<Saved> {
        let response = self
            .authed(self.agent.put(self.url(&Self::memory_path(name))))
            .send_json(body)?;
        Ok(check(response, &format!("saving {name}"))?.body_mut().read_json()?)
    }

    pub fn get(&self, name: &str) -> Result<Option<Memory>> {
        self.read(name, &Self::memory_path(name))
    }

    pub fn recall(&self, name: &str) -> Result<Option<Memory>> {
        self.read(name, &format!("{}?recall=true", Self::memory_path(name)))
    }

    fn read(&self, name: &str, path: &str) -> Result<Option<Memory>> {
        let response = self.authed(self.agent.get(self.url(path))).call()?;
        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        let single: Single = check(response, &format!("reading {name}"))?.body_mut().read_json()?;
        Ok(Some(single.memory))
    }

    pub fn delete(&self, name: &str) -> Result<bool> {
        let response = self
            .authed(self.agent.delete(self.url(&Self::memory_path(name))))
            .call()?;
        if response.status().as_u16() == 404 {
            return Ok(false);
        }
        check(response, &format!("deleting {name}"))?;
        Ok(true)
    }

    pub fn list(&self, tags: &[String], since: i64, cursor: &str, limit: u32) -> Result<Page> {
        let mut query = vec![format!("since={since}"), format!("limit={limit}")];
        query.extend(tags.iter().map(|tag| format!("tag={}", encode(tag))));
        if !cursor.is_empty() {
            query.push(format!("cursor={}", encode(cursor)));
        }
        let response = self
            .authed(self.agent.get(self.url(&format!("/v1/memories?{}", query.join("&")))))
            .call()?;
        Ok(check(response, "listing memories")?.body_mut().read_json()?)
    }

    pub fn search(&self, request: &SearchRequest) -> Result<SearchResult> {
        let response = self
            .authed(self.agent.post(self.url("/v1/search")))
            .send_json(request)?;
        Ok(check(response, "searching")?.body_mut().read_json()?)
    }

    fn session_path(session_id: &str) -> String {
        format!("/v1/sessions/{}", encode(session_id))
    }

    pub fn sessions(&self) -> Result<Vec<Session>> {
        let response = self.authed(self.agent.get(self.url("/v1/sessions"))).call()?;
        let listed: Sessions = check(response, "listing sessions")?.body_mut().read_json()?;
        Ok(listed.sessions)
    }

    pub fn sync_session(&self, session_id: &str, body: &SessionBody) -> Result<()> {
        let response = self
            .authed(self.agent.put(self.url(&Self::session_path(session_id))))
            .send_json(body)?;
        check(response, &format!("syncing session {session_id}"))?;
        Ok(())
    }

    pub fn post_usage(&self, session_id: &str, body: &UsageBody) -> Result<()> {
        let response = self
            .authed(
                self.agent
                    .post(self.url(&format!("{}/usage", Self::session_path(session_id)))),
            )
            .send_json(body)?;
        check(response, &format!("posting usage for session {session_id}"))?;
        Ok(())
    }

    pub fn end_session(&self, session_id: &str) -> Result<bool> {
        let response = self
            .authed(self.agent.delete(self.url(&Self::session_path(session_id))))
            .call()?;
        if response.status().as_u16() == 404 {
            return Ok(false);
        }
        check(response, &format!("ending session {session_id}"))?;
        Ok(true)
    }

    pub fn send(&self, target: &Target, body: &str) -> Result<Message> {
        let response = self
            .authed(self.agent.post(self.url("/v1/messages")))
            .send_json(serde_json::json!({
                "toDeviceId": target.device_id,
                "toSessionId": target.session_id,
                "body": body,
            }))?;
        let sent: Sent = check(response, &format!("sending to {}", target.device_id))?
            .body_mut()
            .read_json()?;
        Ok(sent.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(device_id: &str, name: &str) -> Device {
        Device {
            device_id: device_id.to_string(),
            name: name.to_string(),
            created_at: 0,
            last_used_at: 0,
            current: false,
        }
    }

    fn session(session_id: &str, name: &str, device_id: &str) -> Session {
        Session {
            session_id: session_id.to_string(),
            name: name.to_string(),
            device_id: device_id.to_string(),
            host: "laptop".to_string(),
            cwd: "/home/you/src/recall".to_string(),
            repo: "repo:github.com/mvhenten/recall".to_string(),
            branch: "work".to_string(),
            commit: "feat(messaging): address one session".to_string(),
            started_at: 1_762_000_000_000,
            last_activity_at: 1_762_000_060_000,
            prompts: 2,
            focus: crate::sessions::Focus::default(),
            mode: "interactive".to_string(),
            permission_mode: "default".to_string(),
            pid: 4242,
            current: false,
        }
    }

    fn host(device_id: &str) -> Target {
        Target {
            device_id: device_id.to_string(),
            session_id: String::new(),
        }
    }

    #[test]
    fn a_host_resolves_by_device_name_without_listing_the_sessions() {
        let devices = [device("d-1", "laptop"), device("d-2", "desktop")];
        let refuse = || -> Result<Vec<Session>> { panic!("a host send must not cost a session listing") };

        assert_eq!(resolve_target(&devices, refuse, "desktop").unwrap(), host("d-2"));
        assert_eq!(resolve_target(&devices, refuse, "d-1").unwrap(), host("d-1"));
        let error = resolve_target(&devices, || Ok(Vec::new()), "deskstop")
            .unwrap_err()
            .to_string();
        assert!(error.contains("no host or session named deskstop"), "{error}");
    }

    #[test]
    fn a_handle_or_a_session_id_resolves_to_the_one_session_it_names() {
        let devices = [device("d-1", "laptop"), device("d-2", "desktop")];
        let sessions = || {
            Ok(vec![
                session("9f8a1b2c", "desktop-9f8a", "d-2"),
                session("c4e21a99", "laptop-c4e2", "d-1"),
            ])
        };
        let desktop_session = Target {
            device_id: "d-2".to_string(),
            session_id: "9f8a1b2c".to_string(),
        };

        assert_eq!(
            resolve_target(&devices, sessions, "desktop-9f8a").unwrap(),
            desktop_session
        );
        assert_eq!(resolve_target(&devices, sessions, "9f8a1b2c").unwrap(), desktop_session);
        let error = resolve_target(&devices, sessions, "desktop-9f8b")
            .unwrap_err()
            .to_string();
        assert!(error.contains("no host or session named desktop-9f8b"), "{error}");
    }

    #[test]
    fn a_device_id_passes_through_even_when_it_is_also_a_name() {
        let devices = [device("d-1", "laptop"), device("d-2", "d-1")];
        let refuse = || -> Result<Vec<Session>> { panic!("a host send must not cost a session listing") };
        assert_eq!(resolve_target(&devices, refuse, "d-1").unwrap(), host("d-1"));
    }

    #[test]
    fn a_device_answers_before_a_session_handle_that_reads_the_same() {
        let devices = [device("d-1", "laptop"), device("d-2", "laptop-c4e2")];
        let refuse = || -> Result<Vec<Session>> { panic!("a host send must not cost a session listing") };
        assert_eq!(resolve_target(&devices, refuse, "laptop-c4e2").unwrap(), host("d-2"));
    }

    #[test]
    fn two_sessions_that_answer_to_one_handle_are_refused() {
        let devices = [device("d-1", "laptop")];
        let sessions = || {
            Ok(vec![
                session("c4e21a99", "laptop-c4e2", "d-1"),
                session("c4e2ff00", "laptop-c4e2", "d-1"),
            ])
        };

        let error = resolve_target(&devices, sessions, "laptop-c4e2")
            .unwrap_err()
            .to_string();
        assert!(error.contains("ambiguous target laptop-c4e2"), "{error}");
        assert!(error.contains("c4e21a99, c4e2ff00"), "{error}");
    }

    #[test]
    fn a_usage_delta_is_sent_as_the_host_and_repo_around_what_the_record_holds() {
        let event = crate::sessions::UsageEvent {
            seq: 1200,
            provider: "claude".to_string(),
            account: "you@example.com".to_string(),
            model: "claude-opus-4".to_string(),
            prompts: 2,
            at: 1_762_000_050_000,
            input_tokens: 11,
            output_tokens: 22,
            cache_write_tokens: 33,
            cache_read_tokens: 44,
        };
        let body = UsageBody {
            host: "laptop",
            repo: "repo:github.com/mvhenten/recall",
            event: &event,
        };

        let sent: serde_json::Value = serde_json::from_str(&serde_json::to_string(&body).unwrap()).unwrap();
        assert_eq!(
            sent,
            serde_json::json!({
                "host": "laptop",
                "repo": "repo:github.com/mvhenten/recall",
                "seq": 1200,
                "provider": "claude",
                "account": "you@example.com",
                "model": "claude-opus-4",
                "prompts": 2,
                "at": 1_762_000_050_000_i64,
                "inputTokens": 11,
                "outputTokens": 22,
                "cacheWriteTokens": 33,
                "cacheReadTokens": 44,
            })
        );
    }
}
