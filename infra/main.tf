locals {
  emails = distinct(flatten([for user in var.users : [for email in user.emails : lower(email)]]))
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
  for_each = toset(["mvhenten/control"])

  account_id = var.account_id
  name       = "recall-${replace(each.key, "/", "-")}"
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

resource "cloudflare_zero_trust_access_policy" "bypass" {
  account_id = var.account_id
  name       = "recall api"
  decision   = "bypass"
  include    = [{ everyone = {} }]
}

resource "cloudflare_zero_trust_access_policy" "approvers" {
  account_id = var.account_id
  name       = "recall device approvers"
  decision   = "allow"
  include    = [for email in local.emails : { email = { email = email } }]
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
      id         = cloudflare_zero_trust_access_policy.bypass.id
      precedence = 1
    }
  ]
}

resource "cloudflare_zero_trust_access_application" "device" {
  account_id                = var.account_id
  name                      = "recall device approval"
  type                      = "self_hosted"
  domain                    = "${var.hostname}/device"
  session_duration          = "24h"
  app_launcher_visible      = false
  allowed_idps              = [var.otp_idp_id]
  auto_redirect_to_identity = true
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.approvers.id
      precedence = 1
    }
  ]
}
