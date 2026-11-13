mock_provider "google" {}

variables {
  project_id                  = "nwf-shared"
  service_name                = "manifests-preview"
  image                       = "us-east1-docker.pkg.dev/nwf-shared/apps/manifests-io@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  otlp_headers_secret         = "manifests-preview-otlp-headers"
  otlp_headers_secret_version = "1"
  manage_project_apis          = false
}

run "current_defaults_unchanged" {
  command = plan
  assert {
    condition = (
      google_cloud_run_v2_service.app[0].template[0].containers[0].resources[0].cpu_idle &&
      length(google_cloud_run_v2_service.app[0].template[0].containers[0].liveness_probe) == 0 &&
      toset([for setting in google_cloud_run_v2_service.app[0].template[0].containers[0].env : setting.name]) ==
      toset(["SITE_URL", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_EXPORTER_OTLP_HEADERS"])
    )
    error_message = "Optional preview inputs must not change defaults or environment membership."
  }
}

run "retained_preview_compatibility" {
  command = plan
  variables {
    cloud_run_cpu_idle = false
    cloud_run_liveness_probe = {
      path = "/healthz", port = 8080, period_seconds = 30, timeout_seconds = 1, failure_threshold = 3
    }
    otel_bsp_schedule_delay_ms  = 1000
    otel_blrp_schedule_delay_ms = 1000
  }
  assert {
    condition = (
      !google_cloud_run_v2_service.app[0].template[0].containers[0].resources[0].cpu_idle &&
      google_cloud_run_v2_service.app[0].template[0].containers[0].liveness_probe[0].period_seconds == 30 &&
      google_cloud_run_v2_service.app[0].template[0].containers[0].liveness_probe[0].timeout_seconds == 1 &&
      google_cloud_run_v2_service.app[0].template[0].containers[0].liveness_probe[0].failure_threshold == 3 &&
      google_cloud_run_v2_service.app[0].template[0].containers[0].liveness_probe[0].http_get[0].path == "/healthz" &&
      toset([for setting in google_cloud_run_v2_service.app[0].template[0].containers[0].env : setting.name]) ==
      toset(["SITE_URL", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_BSP_SCHEDULE_DELAY", "OTEL_BLRP_SCHEDULE_DELAY", "OTEL_EXPORTER_OTLP_HEADERS"]) &&
      alltrue([for setting in google_cloud_run_v2_service.app[0].template[0].containers[0].env : setting.value == "1000" if contains(["OTEL_BSP_SCHEDULE_DELAY", "OTEL_BLRP_SCHEDULE_DELAY"], setting.name)])
    )
    error_message = "Adoption must preserve CPU, exact probe and both named exporter delays."
  }
  assert {
    condition     = length(google_storage_bucket.static) == 0 && google_cloud_run_v2_service.app[0].deletion_protection && google_cloud_run_v2_service_iam_member.public[0].member == "allUsers"
    error_message = "Compatibility must not change storage, deletion protection or invoker audience."
  }
}

run "explicit_preview_identity" {
  command = plan
  variables {
    otel_service_name = "manifests-preview"
  }
  assert {
    condition     = one([for setting in google_cloud_run_v2_service.app[0].template[0].containers[0].env : setting.value if setting.name == "OTEL_SERVICE_NAME"]) == "manifests-preview"
    error_message = "Preview identity must be explicitly selected for the telemetry cutover."
  }
}

run "reject_unbounded_delay_and_probe" {
  command = plan
  variables {
    otel_bsp_schedule_delay_ms  = 0
    otel_blrp_schedule_delay_ms = 1.5
    otel_service_name           = "arbitrary"
    cloud_run_liveness_probe = {
      path = "/private", port = 9000, period_seconds = 30, timeout_seconds = 1, failure_threshold = 3
    }
  }
  expect_failures = [var.otel_bsp_schedule_delay_ms, var.otel_blrp_schedule_delay_ms, var.otel_service_name, var.cloud_run_liveness_probe]
}
