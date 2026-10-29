locals {
  principals = merge([
    for user_id, user in var.users : {
      for host in user.hosts : "${user_id}/${host}" => { user_id = user_id, host = host }
    }
  ]...)
}

data "cloudflare_zero_trust_organization" "this" {
  account_id = var.account_id
}

resource "cloudflare_d1_database" "recall" {
  account_id            = var.account_id
  name                  = "recall"
  primary_location_hint = "weur"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_service_token" "principal" {
  for_each = local.principals

  account_id = var.account_id
  name       = "recall-${each.value.user_id}-${each.value.host}"
  duration   = "forever"
}

resource "cloudflare_zero_trust_access_policy" "service_tokens" {
  account_id = var.account_id
  name       = "recall service tokens"
  decision   = "non_identity"
  include = [
    for token in cloudflare_zero_trust_access_service_token.principal : {
      service_token = { token_id = token.id }
    }
  ]
}

resource "cloudflare_zero_trust_access_application" "recall" {
  account_id                = var.account_id
  name                      = "recall"
  type                      = "self_hosted"
  domain                    = var.hostname
  session_duration          = "24h"
  app_launcher_visible      = false
  service_auth_401_redirect = true
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.service_tokens.id
      precedence = 1
    }
  ]
}
