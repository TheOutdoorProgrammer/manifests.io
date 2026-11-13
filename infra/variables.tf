variable "project_id" {
  description = "Existing GCP project with billing enabled."
  type        = string
}

variable "region" {
  description = "Google Cloud deployment region."
  type        = string
  default     = "us-east1"
}

variable "cloud_run_enabled" {
  description = "Retain the Cloud Run origin while provisioning and validating static delivery."
  type        = bool
  default     = true
}

variable "cloud_run_deletion_protection" {
  description = "Disable in a separate successful apply before removing the Cloud Run origin."
  type        = bool
  default     = true
}

variable "cloud_run_cpu_idle" {
  description = "Throttle CPU outside requests; false preserves an existing instance-based preview."
  type        = bool
  default     = true
}

variable "cloud_run_liveness_probe" {
  description = "Optional existing HTTP liveness probe to preserve during runtime adoption."
  type = object({
    path              = string
    port              = number
    period_seconds    = number
    timeout_seconds   = number
    failure_threshold = number
  })
  default = null
  validation {
    condition = var.cloud_run_liveness_probe == null ? true : (
      var.cloud_run_liveness_probe.path == "/healthz" &&
      var.cloud_run_liveness_probe.port == 8080 &&
      var.cloud_run_liveness_probe.period_seconds >= 1 && var.cloud_run_liveness_probe.period_seconds <= 240 &&
      var.cloud_run_liveness_probe.timeout_seconds >= 1 && var.cloud_run_liveness_probe.timeout_seconds <= var.cloud_run_liveness_probe.period_seconds &&
      var.cloud_run_liveness_probe.failure_threshold >= 1 && var.cloud_run_liveness_probe.failure_threshold <= 10 &&
      alltrue([for value in [var.cloud_run_liveness_probe.period_seconds, var.cloud_run_liveness_probe.timeout_seconds, var.cloud_run_liveness_probe.failure_threshold] : floor(value) == value])
    )
    error_message = "Use /healthz on port 8080 with bounded integer probe settings."
  }
}

variable "otel_bsp_schedule_delay_ms" {
  description = "Optional trace batch delay; null preserves the current exporter default."
  type        = number
  default     = null
  validation {
    condition     = var.otel_bsp_schedule_delay_ms == null ? true : (var.otel_bsp_schedule_delay_ms >= 1 && var.otel_bsp_schedule_delay_ms <= 60000 && floor(var.otel_bsp_schedule_delay_ms) == var.otel_bsp_schedule_delay_ms)
    error_message = "Use null or an integer delay from 1 to 60000 milliseconds."
  }
}

variable "otel_blrp_schedule_delay_ms" {
  description = "Optional log batch delay; null preserves the current exporter default."
  type        = number
  default     = null
  validation {
    condition     = var.otel_blrp_schedule_delay_ms == null ? true : (var.otel_blrp_schedule_delay_ms >= 1 && var.otel_blrp_schedule_delay_ms <= 60000 && floor(var.otel_blrp_schedule_delay_ms) == var.otel_blrp_schedule_delay_ms)
    error_message = "Use null or an integer delay from 1 to 60000 milliseconds."
  }
}

variable "otel_service_name" {
  description = "Optional canonical runtime identity; null preserves the compiled default."
  type        = string
  default     = null
  validation {
    condition     = var.otel_service_name == null ? true : contains(["manifests.io", "manifests-preview"], var.otel_service_name)
    error_message = "Use null, manifests.io or manifests-preview."
  }
}

variable "static_bucket_name" {
  description = "Optional globally unique bucket for immutable public static objects."
  type        = string
  default     = ""
  validation {
    condition     = var.static_bucket_name == "" || can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.static_bucket_name))
    error_message = "Use a lowercase bucket name of 3 to 63 characters without dots."
  }
}

variable "manage_project_apis" {
  description = "Disable when shared project infrastructure already owns the required API resources."
  type        = bool
  default     = true
}

variable "service_name" {
  description = "Cloud Run service and dedicated runtime service account name."
  type        = string
  default     = "manifests-io"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.service_name))
    error_message = "Use a lowercase service account name of 6 to 30 characters."
  }
}

variable "site_url" {
  description = "Canonical HTTPS origin. Set to the Cloud Run URL for a preview deployment."
  type        = string
  default     = "https://www.manifests.io"
  validation {
    condition     = can(regex("^https://[^/@?#:]+(:[0-9]+)?$", var.site_url))
    error_message = "Use an HTTPS origin without a path, credentials, query, or fragment."
  }
}

variable "image" {
  description = "Existing linux/amd64 container image pinned to its immutable SHA256 digest."
  type        = string
  default     = ""
  validation {
    condition     = (!var.cloud_run_enabled && var.image == "") || can(regex("^[^[:space:]]+@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Pin the image with @sha256:<64 lowercase hex characters>."
  }
}

variable "max_instances" {
  description = "Upper bound on Cloud Run instances."
  type        = number
  default     = 5
  validation {
    condition     = var.max_instances >= 1 && var.max_instances <= 20 && floor(var.max_instances) == var.max_instances
    error_message = "Choose an integer from 1 to 20."
  }
}

variable "otlp_endpoint" {
  description = "OTLP HTTP base endpoint without credentials or a signal-specific path."
  type        = string
  default     = "https://otlp-gateway-prod-us-east-3.grafana.net/otlp"
  validation {
    condition     = can(regex("^https://[^@/?#]+(/[^?#]*)?$", var.otlp_endpoint))
    error_message = "Use an HTTPS endpoint without embedded credentials, queries, or fragments."
  }
}

variable "otlp_headers_secret" {
  description = "Existing Secret Manager secret ID in this project containing OTLP headers."
  type        = string
}

variable "otlp_headers_secret_version" {
  description = "Pinned numeric version of the existing OTLP header secret."
  type        = string
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.otlp_headers_secret_version))
    error_message = "Pin a numeric secret version for reproducible revisions."
  }
}
