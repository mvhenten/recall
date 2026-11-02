output "d1_database_id" {
  value = cloudflare_d1_database.recall.id
}

output "hostname" {
  value = var.hostname
}

output "access_aud" {
  value = join(",", [
    cloudflare_zero_trust_access_application.device.aud,
    cloudflare_zero_trust_access_application.dashboard.aud,
  ])
}

output "access_team_domain" {
  value = data.cloudflare_zero_trust_organization.this.auth_domain
}
