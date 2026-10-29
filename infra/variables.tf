variable "account_id" {
  type        = string
  description = "Cloudflare account that runs recall."
}

variable "hostname" {
  type        = string
  description = "Hostname the Worker serves behind Cloudflare Access."
}

variable "users" {
  type = map(object({
    hosts = list(string)
  }))
  description = "Each user id and the hosts that get their own Access service token."

  validation {
    condition = alltrue(flatten([
      for user_id, user in var.users : concat(
        [can(regex("^[a-z0-9][a-z0-9-]*$", user_id))],
        [for host in user.hosts : can(regex("^[a-z0-9][a-z0-9-]*$", host))],
      )
    ]))
    error_message = "User ids and host names are lower-case letters, digits and dashes."
  }
}
