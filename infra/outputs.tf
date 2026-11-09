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

# The audience of the application fronting /oauth/consent, and the whole of what a deployment binds
# to serve a connector: it is what the Worker holds a connector sign-in to.
output "mcp_access_aud" {
  value = var.mcp_connector ? one(cloudflare_zero_trust_access_application.mcp[*].aud) : ""
}

output "access_team_domain" {
  value = data.cloudflare_zero_trust_organization.this.auth_domain
}

# Only the email application's audience is bound. The link application mints no JWT, so there is no
# audience to verify on that lane and binding one would suggest otherwise.
output "artifact_share_access_aud" {
  value = var.artifact_hostname == "" ? "" : one(cloudflare_zero_trust_access_application.share_emails[*].aud)
}
