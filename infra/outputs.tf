output "d1_database_id" {
  value = cloudflare_d1_database.recall.id
}

output "hostname" {
  value = var.hostname
}

output "access_aud" {
  value = cloudflare_zero_trust_access_application.device.aud
}

output "access_team_domain" {
  value = data.cloudflare_zero_trust_organization.this.auth_domain
}

output "principals" {
  value = [
    for key, principal in local.principals : {
      client_id     = cloudflare_zero_trust_access_service_token.principal[key].client_id
      secret_sha256 = nonsensitive(sha256(cloudflare_zero_trust_access_service_token.principal[key].client_secret))
      user_id       = principal.user_id
      host          = principal.host
    }
  ]
}
