variable "account_id" {
  type        = string
  description = "Cloudflare account that runs recall."
}

variable "hostname" {
  type        = string
  description = "Hostname the Worker serves; only /device, /dashboard and /oauth/consent sit behind a Cloudflare Access login."
}

variable "artifact_hostname" {
  type        = string
  default     = ""
  description = "Hostname that serves published pages, wholly behind its own Access login. Empty leaves it off."

  validation {
    condition     = var.artifact_hostname == "" || var.artifact_hostname != var.hostname
    error_message = "The artifact hostname is a second host, so it cannot be the one the dashboard and the API answer on."
  }
}

variable "mcp_connector" {
  type        = bool
  default     = false
  description = "Serve the MCP connector at <hostname>/mcp, with its OAuth sign-in step behind its own Access application and one service token per user. False leaves it off."
}

variable "otp_idp_id" {
  type        = string
  description = "Id of the account's one-time PIN Access login method."
}

variable "users" {
  type = map(object({
    emails = list(string)
  }))
  description = "Each user id and the emails that sign in as it."

  validation {
    condition = alltrue(flatten([
      for user_id, user in var.users : concat(
        [can(regex("^[a-z0-9][a-z0-9-]*$", user_id)), length(user.emails) > 0],
        [for email in user.emails : can(regex("^[^@\\s]+@[^@\\s]+$", email))],
      )
    ]))
    error_message = "User ids are lower-case letters, digits and dashes, and each user has at least one email address."
  }
}
