terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 7.0, < 8.9"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_project_service" "required" {
  for_each           = var.manage_project_apis ? toset(concat(var.cloud_run_enabled ? ["run.googleapis.com", "secretmanager.googleapis.com"] : [], var.static_bucket_name != "" ? ["storage.googleapis.com"] : [])) : toset([])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "runtime" {
  count        = var.cloud_run_enabled ? 1 : 0
  project      = var.project_id
  account_id   = var.service_name
  display_name = "Manifests.io Cloud Run runtime"
}

resource "google_secret_manager_secret_iam_member" "telemetry" {
  count     = var.cloud_run_enabled ? 1 : 0
  project   = var.project_id
  secret_id = var.otlp_headers_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime[0].email}"
}

resource "google_cloud_run_v2_service" "app" {
  count               = var.cloud_run_enabled ? 1 : 0
  project             = var.project_id
  name                = var.service_name
  location            = var.region
  deletion_protection = var.cloud_run_deletion_protection
  ingress             = "INGRESS_TRAFFIC_ALL"

  template {
    service_account                  = google_service_account.runtime[0].email
    timeout                          = "30s"
    max_instance_request_concurrency = 40

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image
      ports {
        container_port = 8080
      }
      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      startup_probe {
        period_seconds    = 2
        timeout_seconds   = 1
        failure_threshold = 60
        http_get {
          path = "/readyz"
          port = 8080
        }
      }
      env {
        name  = "SITE_URL"
        value = var.site_url
      }
      env {
        name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
        value = var.otlp_endpoint
      }
      env {
        name  = "OTEL_EXPORTER_OTLP_PROTOCOL"
        value = "http/protobuf"
      }
      env {
        name = "OTEL_EXPORTER_OTLP_HEADERS"
        value_source {
          secret_key_ref {
            secret  = var.otlp_headers_secret
            version = var.otlp_headers_secret_version
          }
        }
      }
    }
  }

  depends_on = [google_project_service.required, google_secret_manager_secret_iam_member.telemetry]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.cloud_run_enabled ? 1 : 0
  project  = var.project_id
  location = google_cloud_run_v2_service.app[0].location
  name     = google_cloud_run_v2_service.app[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

moved {
  from = google_service_account.runtime
  to   = google_service_account.runtime[0]
}

moved {
  from = google_secret_manager_secret_iam_member.telemetry
  to   = google_secret_manager_secret_iam_member.telemetry[0]
}

moved {
  from = google_cloud_run_v2_service.app
  to   = google_cloud_run_v2_service.app[0]
}

moved {
  from = google_cloud_run_v2_service_iam_member.public
  to   = google_cloud_run_v2_service_iam_member.public[0]
}
