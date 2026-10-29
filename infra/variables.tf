variable "account_id" {
  type        = string
  description = "Cloudflare account that runs recall."
}

variable "hostname" {
  type        = string
  description = "Hostname the Worker serves; only /device sits behind a Cloudflare Access login."
}

variable "otp_idp_id" {
  type        = string
  description = "Id of the account's one-time PIN Access login method."
}

variable "users" {
  type = map(object({
    emails = list(string)
    hosts  = optional(list(string), [])
  }))
  description = "Each user id, the emails that sign in as it, and the hosts that keep a legacy Access service token."

  validation {
    condition = alltrue(flatten([
      for user_id, user in var.users : concat(
        [can(regex("^[a-z0-9][a-z0-9-]*$", user_id)), length(user.emails) > 0],
        [for email in user.emails : can(regex("^[^@\\s]+@[^@\\s]+$", email))],
        [for host in user.hosts : can(regex("^[a-z0-9][a-z0-9-]*$", host))],
      )
    ]))
    error_message = "User ids and host names are lower-case letters, digits and dashes, and each user has at least one email."
  }
}
