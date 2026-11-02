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

output "access_team_domain" {
  value = data.cloudflare_zero_trust_organization.this.auth_domain
}
