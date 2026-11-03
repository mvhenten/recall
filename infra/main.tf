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
