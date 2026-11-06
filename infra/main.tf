locals {
  emails = distinct(flatten([for user in var.users : [for email in user.emails : lower(email)]]))

  # The two prefixes a share answers under. Access matches the most specific application — the
  # longest path — before the hostname-wide one, so each prefix carries its own policy and the
  # application covering the host is unchanged. Neither can collide with an artifact, because every
  # artifact address begins /a/; that holds structurally and not by the name grammar.
  share_link_prefix  = "/link"
  share_email_prefix = "/email"
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

resource "cloudflare_queue" "transcripts" {
  account_id = var.account_id
  queue_name = "recall-transcripts"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_queue" "transcripts_dead" {
  account_id = var.account_id
  queue_name = "recall-transcripts-dead"

  lifecycle {
    prevent_destroy = true
  }
}

# Every stretch written to the archive wakes the Worker that derives the rest of the service's
# view of it. The consumer is declared in wrangler.jsonc and attached by `wrangler deploy`, since
# the consumer is the script itself; this side is the queue and the rule that feeds it.
#
# `queue_name` reads back as unknown on every plan, so the resource shows an in-place update that
# changes nothing: cloudflare/terraform-provider-cloudflare#7263.
resource "cloudflare_r2_bucket_event_notification" "transcripts" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.transcripts.name
  queue_id    = cloudflare_queue.transcripts.queue_id

  rules = [{
    actions     = ["PutObject", "CompleteMultipartUpload"]
    description = "a transcript stretch landed"
  }]
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
