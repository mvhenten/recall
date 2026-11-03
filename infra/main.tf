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

resource "cloudflare_r2_bucket" "artifacts" {
  count      = var.artifact_hostname == "" ? 0 : 1
  account_id = var.account_id
  name       = "recall-artifacts"
  location   = "weur"
}

resource "cloudflare_r2_bucket" "transcripts" {
  account_id = var.account_id
  name       = "recall-transcripts"
  location   = "weur"

  lifecycle {
    prevent_destroy = true
  }
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

# One service token per user, so the connector endpoint can tell whose memories a token reaches.
# The secret is minted once and lives only in state; rotate it in the dashboard to read it.
resource "cloudflare_zero_trust_access_service_token" "connector" {
  for_each = var.mcp_connector ? var.users : {}

  account_id = var.account_id
  name       = "recall-${each.key}-connector"
  duration   = "forever"
}

resource "cloudflare_zero_trust_access_policy" "connector_tokens" {
  count      = var.mcp_connector ? 1 : 0
  account_id = var.account_id
  name       = "recall connector tokens"
  decision   = "non_identity"
  include = [
    for token in cloudflare_zero_trust_access_service_token.connector : {
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
      id         = cloudflare_zero_trust_access_policy.bypass.id
      precedence = 1
    }
  ]
}

resource "cloudflare_zero_trust_access_application" "artifacts" {
  count                     = var.artifact_hostname == "" ? 0 : 1
  account_id                = var.account_id
  name                      = "recall artifacts"
  type                      = "self_hosted"
  domain                    = var.artifact_hostname
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

# The connector answers on a path of the main hostname, so it takes an application of its own
# rather than a second host. It admits the approver emails and the connector service tokens, and
# answers 401 instead of redirecting, since nothing behind it renders a login page.
resource "cloudflare_zero_trust_access_application" "mcp" {
  count                     = var.mcp_connector ? 1 : 0
  account_id                = var.account_id
  name                      = "recall connector"
  type                      = "self_hosted"
  session_duration          = "24h"
  app_launcher_visible      = false
  allowed_idps              = [var.otp_idp_id]
  service_auth_401_redirect = true
  destinations = [
    {
      type = "public"
      uri  = "${var.hostname}/mcp"
    }
  ]
  policies = [
    {
      id         = one(cloudflare_zero_trust_access_policy.connector_tokens[*].id)
      precedence = 1
    },
    {
      id         = cloudflare_zero_trust_access_policy.approvers.id
      precedence = 2
    }
  ]
}

resource "cloudflare_zero_trust_access_application" "device" {
  account_id                = var.account_id
  name                      = "recall browser pages"
  type                      = "self_hosted"
  session_duration          = "24h"
  app_launcher_visible      = false
  allowed_idps              = [var.otp_idp_id]
  auto_redirect_to_identity = true
  destinations = [
    {
      type = "public"
      uri  = "${var.hostname}/device"
    },
    {
      type = "public"
      uri  = "${var.hostname}/dashboard"
    }
  ]
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.approvers.id
      precedence = 1
    }
  ]
}
