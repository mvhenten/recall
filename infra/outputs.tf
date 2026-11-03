output "d1_database_id" {
  value = cloudflare_d1_database.recall.id
}

output "transcript_bucket" {
  value = cloudflare_r2_bucket.transcripts.name
}

output "hostname" {
  value = var.hostname
}

output "access_aud" {
  value = cloudflare_zero_trust_access_application.device.aud
}

output "artifact_hostname" {
  value = var.artifact_hostname
}

output "artifact_bucket" {
  value = var.artifact_hostname == "" ? "" : one(cloudflare_r2_bucket.artifacts[*].name)
}

output "artifact_access_aud" {
  value = var.artifact_hostname == "" ? "" : one(cloudflare_zero_trust_access_application.artifacts[*].aud)
}

output "mcp_access_aud" {
  value = var.mcp_connector ? one(cloudflare_zero_trust_access_application.mcp[*].aud) : ""
}

# Access client id to user id, which is how the Worker reads a service token's common name back to
# the user it acts for. The secret of each token stays in state and is never an output.
output "mcp_service_clients" {
  value = jsonencode({
    for user_id, token in cloudflare_zero_trust_access_service_token.connector : token.client_id => user_id
  })
}

output "access_team_domain" {
  value = data.cloudflare_zero_trust_organization.this.auth_domain
}
