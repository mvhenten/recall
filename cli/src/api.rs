use crate::config::Config;
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use ureq::Agent;
use ureq::http::Response;

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

#[derive(Deserialize)]
struct Hits {
    hits: Vec<Hit>,
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
        300..=399 => {
            "; Cloudflare Access refused the service token, check RECALL_CLIENT_ID and RECALL_CLIENT_SECRET in the recall env file"
        }
        401 | 403 => "; check RECALL_CLIENT_ID and RECALL_CLIENT_SECRET in the recall env file",
        _ => "",
    };
    bail!("{what} failed with {status}: {}{hint}", text.trim())
}

impl Client {
    pub fn new(config: Config) -> Client {
        let agent: Agent = Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(5)))
            .timeout_global(Some(Duration::from_secs(20)))
            .http_status_as_error(false)
            .max_redirects(0)
            .build()
            .into();
        Client { agent, config }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.config.endpoint)
    }

    fn memory_path(name: &str) -> String {
        format!("/v1/memories/{}", encode(name))
    }

    pub fn save(&self, name: &str, body: &SaveBody) -> Result<Saved> {
        let response = self
            .agent
            .put(self.url(&Self::memory_path(name)))
            .header("cf-access-client-id", &self.config.client_id)
            .header("cf-access-client-secret", &self.config.client_secret)
            .send_json(body)?;
        Ok(check(response, &format!("saving {name}"))?.body_mut().read_json()?)
    }

    pub fn get(&self, name: &str) -> Result<Option<Memory>> {
        let response = self
            .agent
            .get(self.url(&Self::memory_path(name)))
            .header("cf-access-client-id", &self.config.client_id)
            .header("cf-access-client-secret", &self.config.client_secret)
            .call()?;
        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        let single: Single = check(response, &format!("reading {name}"))?.body_mut().read_json()?;
        Ok(Some(single.memory))
    }

    pub fn delete(&self, name: &str) -> Result<bool> {
        let response = self
            .agent
            .delete(self.url(&Self::memory_path(name)))
            .header("cf-access-client-id", &self.config.client_id)
            .header("cf-access-client-secret", &self.config.client_secret)
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
            .agent
            .get(self.url(&format!("/v1/memories?{}", query.join("&"))))
            .header("cf-access-client-id", &self.config.client_id)
            .header("cf-access-client-secret", &self.config.client_secret)
            .call()?;
        Ok(check(response, "listing memories")?.body_mut().read_json()?)
    }

    pub fn search(&self, request: &SearchRequest) -> Result<Vec<Hit>> {
        let response = self
            .agent
            .post(self.url("/v1/search"))
            .header("cf-access-client-id", &self.config.client_id)
            .header("cf-access-client-secret", &self.config.client_secret)
            .send_json(request)?;
        let hits: Hits = check(response, "searching")?.body_mut().read_json()?;
        Ok(hits.hits)
    }
}
