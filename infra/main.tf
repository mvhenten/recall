locals {
  emails = distinct(flatten([for user in var.users : [for email in user.emails : lower(email)]]))

  # The two prefixes a share answers under. Access matches the most specific application — the
  # longest path — before the hostname-wide one, so each prefix carries its own policy and the
  # application covering the host is unchanged. Neither can collide with an artifact, because every
  # artifact address begins /a/; that holds structurally and not by the name grammar.
  share_link_prefix  = "/link"
  share_email_prefix = "/email"

  # The one address of the connector that sits behind an Access login, which CONSENT_PATH in
  # src/oauth.ts names too. The endpoint itself, the two discovery documents, the registration
  # endpoint and the token endpoint are all deliberately outside it: a web MCP client starts its
  # connect flow from an unauthenticated request to /mcp and the 401 it answers, and an Access
  # application over that path answers the 401 itself, stripping the header the whole flow turns on.
  oauth_consent_prefix = "/oauth/consent"
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

# The service token per user and the non-identity policy that admitted them are gone. They worked
# because Access fronted /mcp and exchanged the client id and secret for an assertion; /mcp is now
# outside Access, so nothing exchanges a pair and no request can carry one. A connector authorizes
# itself through the OAuth flow instead, and `npm-scripts/deploy.mjs` retires the three resources.

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

# The sign-in step of the connector's authorization flow, which is the whole of what Access covers
# here. The browser lands on this path carrying the client's authorization request, Access redirects
# it to the one-time PIN, and the assertion it comes back with is what names the account the token
# is minted for. It redirects rather than answering 401 because a person is reading it.
#
# Access matches the longest path first, so this covers /oauth/consent and the bypass over the
# hostname leaves /mcp, the discovery documents, /oauth/register, /oauth/authorize and /oauth/token
# to the Worker. Only a person gets through it: the policy admits the approver emails and nothing
# else, because the consent is a person's to give.
resource "cloudflare_zero_trust_access_application" "mcp" {
  count                     = var.mcp_connector ? 1 : 0
  account_id                = var.account_id
  name                      = "recall connector"
  type                      = "self_hosted"
  session_duration          = "24h"
  app_launcher_visible      = false
  allowed_idps              = [var.otp_idp_id]
  auto_redirect_to_identity = true
  destinations = [
    {
      type = "public"
      uri  = "${var.hostname}${local.oauth_consent_prefix}"
    }
  ]
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.approvers.id
      precedence = 1
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

# The link prefix takes no sign-in at all: the token in the address is the only credential, and the
# Worker hashes it to find one share. The bypass is scoped to this path and goes nowhere near the
# application covering the hostname.
resource "cloudflare_zero_trust_access_policy" "share_link_bypass" {
  count      = var.artifact_hostname == "" ? 0 : 1
  account_id = var.account_id
  name       = "recall artifact link shares"
  decision   = "bypass"
  include    = [{ everyone = {} }]
}

# Any address Cloudflare's one-time PIN proves gets through. The policy proves an address and
# decides nothing else; which artifact that address reaches is the share row's to say. `allow` plus
# `everyone` is not `bypass`: it demands an identity and accepts whichever one completes the PIN.
resource "cloudflare_zero_trust_access_policy" "share_readers" {
  count      = var.artifact_hostname == "" ? 0 : 1
  account_id = var.account_id
  name       = "recall artifact share readers"
  decision   = "allow"
  include    = [{ everyone = {} }]
}

resource "cloudflare_zero_trust_access_application" "share_links" {
  count                     = var.artifact_hostname == "" ? 0 : 1
  account_id                = var.account_id
  name                      = "recall artifact link shares"
  type                      = "self_hosted"
  session_duration          = "24h"
  app_launcher_visible      = false
  service_auth_401_redirect = true
  destinations = [
    {
      type = "public"
      uri  = "${var.artifact_hostname}${local.share_link_prefix}"
    }
  ]
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.share_link_bypass[0].id
      precedence = 1
    }
  ]
}

resource "cloudflare_zero_trust_access_application" "share_emails" {
  count                     = var.artifact_hostname == "" ? 0 : 1
  account_id                = var.account_id
  name                      = "recall artifact email shares"
  type                      = "self_hosted"
  session_duration          = "24h"
  app_launcher_visible      = false
  allowed_idps              = [var.otp_idp_id]
  auto_redirect_to_identity = true
  destinations = [
    {
      type = "public"
      uri  = "${var.artifact_hostname}${local.share_email_prefix}"
    }
  ]
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.share_readers[0].id
      precedence = 1
    }
  ]
}
