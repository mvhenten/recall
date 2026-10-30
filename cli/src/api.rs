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
}
