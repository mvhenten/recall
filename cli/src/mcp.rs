use crate::api::{self, Client, SaveBody};
use crate::{config, markdown, repo};
use anyhow::{Result, bail};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ServerHandler, ServiceExt, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

const INSTRUCTIONS: &str = "recall is the user's durable memory across sessions, hosts and harnesses. Search it before answering from assumptions about the user or the project, and save what will matter in a later conversation.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum MemoryType {
    User,
    Feedback,
    Project,
    Reference,
}

impl MemoryType {
    fn as_str(self) -> &'static str {
        match self {
            MemoryType::User => "user",
            MemoryType::Feedback => "feedback",
            MemoryType::Project => "project",
            MemoryType::Reference => "reference",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    Hybrid,
    Vector,
    Text,
}

impl SearchMode {
    fn as_str(self) -> &'static str {
        match self {
            SearchMode::Hybrid => "hybrid",
            SearchMode::Vector => "vector",
            SearchMode::Text => "text",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchParams {
    /// What to look for, in plain words or an exact identifier.
    pub query: String,
    /// hybrid (default) ranks by meaning and words; text matches exact identifiers; vector by meaning only.
    pub mode: Option<SearchMode>,
    /// Search these tags instead of the current repo tag plus global.
    pub tags: Option<Vec<String>>,
    /// Search every memory, whatever its tags.
    pub any: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NameParams {
    /// The memory's kebab-case name.
    pub name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListParams {
    /// List these tags instead of the current repo tag plus global.
    pub tags: Option<Vec<String>>,
    /// Only memories created at or after this ISO 8601 time, date or epoch ms.
    pub since: Option<String>,
    /// At most this many, newest first (default 20).
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SaveParams {
    /// Unique kebab-case name; saving an existing name replaces that memory.
    pub name: String,
    /// One line that says when this memory is relevant.
    pub description: String,
    /// user: who the user is; feedback: how the user wants you to work; project: ongoing work and decisions; reference: where to find things.
    #[serde(rename = "type")]
    pub kind: MemoryType,
    /// The memory in markdown.
    pub body: String,
    /// Extra free-form tags.
    pub tags: Option<Vec<String>>,
    /// Tag it global instead of with the current repo. Defaults to true for user and feedback, false otherwise.
    pub global: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EditParams {
    /// The memory to change.
    pub name: String,
    /// New one-line description.
    pub description: Option<String>,
    /// New type.
    #[serde(rename = "type")]
    pub kind: Option<MemoryType>,
    /// New markdown body, replacing the old one.
    pub body: Option<String>,
    /// Tags to add.
    pub add_tags: Option<Vec<String>>,
    /// Tags to remove.
    pub remove_tags: Option<Vec<String>>,
}

#[derive(Debug, PartialEq)]
pub struct Edited {
    pub description: String,
    pub kind: String,
    pub body: String,
    pub tags: Vec<String>,
}

fn default_scope(repo_tag: Option<String>) -> Vec<String> {
    repo_tag.into_iter().chain([repo::GLOBAL_TAG.to_string()]).collect()
}

pub fn scope_tags(tags: Option<Vec<String>>, any: bool, repo_tag: Option<String>) -> Result<Vec<String>> {
    let tags = tags.unwrap_or_default();
    match (any, tags.is_empty()) {
        (true, false) => bail!("pass tags or any, not both"),
        (true, true) => Ok(Vec::new()),
        (false, false) => Ok(tags),
        (false, true) => Ok(default_scope(repo_tag)),
    }
}

pub fn save_tags(
    kind: MemoryType,
    global: Option<bool>,
    extra: Option<Vec<String>>,
    repo_tag: Option<String>,
) -> Result<Vec<String>> {
    let global = global.unwrap_or(matches!(kind, MemoryType::User | MemoryType::Feedback));
    let mut tags = extra.unwrap_or_default();
    let scope = match (global, repo_tag) {
        (true, _) => repo::GLOBAL_TAG.to_string(),
        (false, Some(tag)) => tag,
        (false, None) => bail!(
            "no git repository with a remote in the server's directory, so there is no repo tag; pass global: true to save it as a global memory"
        ),
    };
    if !tags.contains(&scope) {
        tags.push(scope);
    }
    Ok(tags)
}

pub fn apply_edit(memory: &api::Memory, params: EditParams) -> Result<Edited> {
    let EditParams {
        name: _,
        description,
        kind,
        body,
        add_tags,
        remove_tags,
    } = params;
    if description.is_none() && kind.is_none() && body.is_none() && add_tags.is_none() && remove_tags.is_none() {
        bail!("nothing to change; pass description, type, body, add_tags or remove_tags");
    }
    let remove = remove_tags.unwrap_or_default();
    let mut tags = memory.tags.clone();
    for tag in add_tags.unwrap_or_default() {
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    tags.retain(|tag| !remove.contains(tag));
    Ok(Edited {
        description: description.unwrap_or_else(|| memory.description.clone()),
        kind: kind.map_or_else(|| memory.kind.clone(), |kind| kind.as_str().to_string()),
        body: body.unwrap_or_else(|| memory.body.clone()),
        tags,
    })
}

fn client() -> Result<Client> {
    Ok(Client::new(config::load()?))
}

fn repo_tag() -> Option<String> {
    repo::repo_tag(&std::env::current_dir().ok()?)
}

fn not_found(name: &str) -> anyhow::Error {
    anyhow::anyhow!("no memory named {name}")
}

fn to_json<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}

fn saved_json(saved: &api::Saved) -> Result<String> {
    to_json(&serde_json::json!({
        "name": saved.memory.name,
        "created": saved.created,
        "tags": saved.memory.tags,
    }))
}

async fn blocking(work: impl FnOnce() -> Result<String> + Send + 'static) -> Result<String, String> {
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(error)) => Err(format!("recall: {error:#}")),
        Err(error) => Err(format!("recall: the call failed unexpectedly: {error}")),
    }
}

#[derive(Clone)]
pub struct Recall {
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl Recall {
    pub fn new() -> Recall {
        Recall {
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        name = "recall_search",
        description = "Search the user's memories. Covers the current repo and global memories unless tags or any is given. Returns {hits, elsewhere}: hits are full memories with a score; elsewhere lists the best matches outside the searched tags by name, so recall_get them if relevant."
    )]
    async fn search(&self, Parameters(params): Parameters<SearchParams>) -> Result<String, String> {
        blocking(move || {
            let any = params.any.unwrap_or(false);
            let tags = scope_tags(params.tags, any, repo_tag())?;
            let mode = params.mode.unwrap_or(SearchMode::Hybrid);
            let result = client()?.search(&api::SearchRequest {
                query: &params.query,
                tags: &tags,
                any,
                limit: 5,
                min_score: 0.55,
                mode: mode.as_str(),
            })?;
            to_json(&result)
        })
        .await
    }

    #[tool(name = "recall_get", description = "Read one memory in full by its name.")]
    async fn get(&self, Parameters(params): Parameters<NameParams>) -> Result<String, String> {
        blocking(move || {
            let memory = client()?.get(&params.name)?.ok_or_else(|| not_found(&params.name))?;
            Ok(markdown::render(&memory))
        })
        .await
    }

    #[tool(
        name = "recall_list",
        description = "List memories, newest created first. Covers the current repo and global memories unless tags is given. Use recall_search to find memories by topic."
    )]
    async fn list(&self, Parameters(params): Parameters<ListParams>) -> Result<String, String> {
        blocking(move || {
            let since = match params.since {
                Some(value) => markdown::parse_since(&value)
                    .ok_or_else(|| anyhow::anyhow!("since {value} is neither epoch ms nor ISO 8601"))?,
                None => 0,
            };
            let tags = scope_tags(params.tags, false, repo_tag())?;
            let page = client()?.list(&tags, since, "", params.limit.unwrap_or(20))?;
            to_json(&page.memories)
        })
        .await
    }

    #[tool(
        name = "recall_save",
        description = "Save a new memory. Search first: if a memory on the topic exists, use recall_edit instead of saving a duplicate. user and feedback memories are global by default; project and reference memories are tagged with the current repo."
    )]
    async fn save(&self, Parameters(params): Parameters<SaveParams>) -> Result<String, String> {
        blocking(move || {
            let tags = save_tags(params.kind, params.global, params.tags, repo_tag())?;
            let saved = client()?.save(
                &params.name,
                &SaveBody {
                    description: &params.description,
                    kind: params.kind.as_str(),
                    body: &params.body,
                    tags: &tags,
                },
            )?;
            saved_json(&saved)
        })
        .await
    }

    #[tool(
        name = "recall_edit",
        description = "Change an existing memory. Only the fields you pass change; body replaces the whole body. Renaming is not supported: save under the new name and delete the old one."
    )]
    async fn edit(&self, Parameters(params): Parameters<EditParams>) -> Result<String, String> {
        blocking(move || {
            let client = client()?;
            let name = params.name.clone();
            let memory = client.get(&name)?.ok_or_else(|| not_found(&name))?;
            let edited = apply_edit(&memory, params)?;
            let saved = client.save(
                &name,
                &SaveBody {
                    description: &edited.description,
                    kind: &edited.kind,
                    body: &edited.body,
                    tags: &edited.tags,
                },
            )?;
            saved_json(&saved)
        })
        .await
    }

    #[tool(
        name = "recall_delete",
        description = "Delete a memory that turned out wrong or no longer holds."
    )]
    async fn delete(&self, Parameters(params): Parameters<NameParams>) -> Result<String, String> {
        blocking(move || {
            if !client()?.delete(&params.name)? {
                return Err(not_found(&params.name));
            }
            to_json(&serde_json::json!({ "deleted": params.name }))
        })
        .await
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Recall {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("recall", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }
}

pub fn serve() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    runtime.block_on(async {
        let service = Recall::new().serve(rmcp::transport::stdio()).await?;
        service.waiting().await?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn tool(name: &str) -> rmcp::model::Tool {
        Recall::new()
            .tool_router
            .list_all()
            .into_iter()
            .find(|tool| tool.name == name)
            .unwrap_or_else(|| panic!("no tool {name}"))
    }

    fn schema(name: &str) -> Value {
        Value::Object(tool(name).input_schema.as_ref().clone())
    }

    fn required(name: &str) -> Vec<String> {
        let mut fields: Vec<String> = schema(name)["required"]
            .as_array()
            .map(|fields| fields.iter().map(|f| f.as_str().unwrap().to_string()).collect())
            .unwrap_or_default();
        fields.sort();
        fields
    }

    fn memory() -> api::Memory {
        api::Memory {
            memory_id: "m1".into(),
            user_id: "u1".into(),
            name: "indent".into(),
            description: "indent style".into(),
            kind: "feedback".into(),
            body: "two spaces".into(),
            tags: vec!["global".into(), "style".into()],
            created_at: 1,
            updated_at: 1,
            recall_count: 0,
            last_recalled_at: 0,
        }
    }

    #[test]
    fn serves_the_six_tools_with_descriptions() {
        let mut names: Vec<String> = Recall::new()
            .tool_router
            .list_all()
            .into_iter()
            .map(|tool| {
                assert!(
                    tool.description.as_deref().is_some_and(|d| !d.is_empty()),
                    "{}",
                    tool.name
                );
                tool.name.to_string()
            })
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "recall_delete",
                "recall_edit",
                "recall_get",
                "recall_list",
                "recall_save",
                "recall_search"
            ]
        );
    }

    #[test]
    fn schemas_require_only_the_essential_fields() {
        assert_eq!(required("recall_search"), ["query"]);
        assert_eq!(required("recall_get"), ["name"]);
        assert_eq!(required("recall_delete"), ["name"]);
        assert!(required("recall_list").is_empty());
        assert_eq!(required("recall_save"), ["body", "description", "name", "type"]);
        assert_eq!(required("recall_edit"), ["name"]);
    }

    #[test]
    fn schemas_name_the_enum_values() {
        let text = schema("recall_save").to_string();
        for kind in ["user", "feedback", "project", "reference"] {
            assert!(text.contains(&format!("\"{kind}\"")), "{kind} in {text}");
        }
        let text = schema("recall_search").to_string();
        for mode in ["hybrid", "vector", "text"] {
            assert!(text.contains(&format!("\"{mode}\"")), "{mode} in {text}");
        }
    }

    #[test]
    fn arguments_deserialize_from_tool_calls() {
        let save: SaveParams = serde_json::from_value(json!({
            "name": "indent", "description": "d", "type": "project", "body": "b", "tags": ["x"]
        }))
        .unwrap();
        assert_eq!(save.kind, MemoryType::Project);
        assert_eq!(save.global, None);
        assert!(
            serde_json::from_value::<SaveParams>(json!({
                "name": "n", "description": "d", "type": "secret", "body": "b"
            }))
            .is_err()
        );
        assert!(serde_json::from_value::<SearchParams>(json!({ "query": "q", "mode": "fuzzy" })).is_err());
        assert!(serde_json::from_value::<NameParams>(json!({ "name": "n", "extra": 1 })).is_err());
    }

    #[test]
    fn scope_defaults_to_repo_and_global() {
        let repo = Some("repo:github.com/acme/widget".to_string());
        assert_eq!(
            scope_tags(None, false, repo.clone()).unwrap(),
            ["repo:github.com/acme/widget", "global"]
        );
        assert_eq!(scope_tags(None, false, None).unwrap(), ["global"]);
        assert_eq!(scope_tags(Some(vec![]), false, None).unwrap(), ["global"]);
        assert_eq!(
            scope_tags(Some(vec!["style".into()]), false, repo.clone()).unwrap(),
            ["style"]
        );
        assert!(scope_tags(None, true, repo.clone()).unwrap().is_empty());
        assert!(scope_tags(Some(vec!["style".into()]), true, repo).is_err());
    }

    #[test]
    fn save_tags_follow_the_cli_defaults() {
        let repo = Some("repo:github.com/acme/widget".to_string());
        assert_eq!(
            save_tags(MemoryType::User, None, None, repo.clone()).unwrap(),
            ["global"]
        );
        assert_eq!(save_tags(MemoryType::Feedback, None, None, None).unwrap(), ["global"]);
        assert_eq!(
            save_tags(MemoryType::Project, None, Some(vec!["x".into()]), repo.clone()).unwrap(),
            ["x", "repo:github.com/acme/widget"]
        );
        assert_eq!(
            save_tags(MemoryType::Feedback, Some(false), None, repo.clone()).unwrap(),
            ["repo:github.com/acme/widget"]
        );
        assert_eq!(
            save_tags(MemoryType::Reference, Some(true), None, repo).unwrap(),
            ["global"]
        );
        let error = save_tags(MemoryType::Project, None, None, None).unwrap_err();
        assert!(error.to_string().contains("pass global: true"), "{error}");
    }

    #[test]
    fn edit_changes_only_the_given_fields() {
        let params: EditParams = serde_json::from_value(json!({
            "name": "indent", "body": "tabs", "add_tags": ["go"], "remove_tags": ["style"]
        }))
        .unwrap();
        assert_eq!(
            apply_edit(&memory(), params).unwrap(),
            Edited {
                description: "indent style".into(),
                kind: "feedback".into(),
                body: "tabs".into(),
                tags: vec!["global".into(), "go".into()],
            }
        );
        let params: EditParams = serde_json::from_value(json!({ "name": "indent", "type": "user" })).unwrap();
        assert_eq!(apply_edit(&memory(), params).unwrap().kind, "user");
        let params: EditParams = serde_json::from_value(json!({ "name": "indent" })).unwrap();
        assert!(apply_edit(&memory(), params).is_err());
    }
}
