package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	logspb "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	tracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestRequestPrivacyPropagationAndCorrelation(t *testing.T) {
	for _, key := range []string{"OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"} {
		t.Setenv(key, "")
	}
	originalLogger, originalProvider, originalPropagator := slog.Default(), otel.GetTracerProvider(), otel.GetTextMapPropagator()
	t.Cleanup(func() {
		slog.SetDefault(originalLogger)
		otel.SetTracerProvider(originalProvider)
		otel.SetTextMapPropagator(originalPropagator)
	})
	shutdown, err := Setup(t.Context(), "test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = shutdown(context.Background()) })
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(privateExporter{SpanExporter: exporter}))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	var output bytes.Buffer
	slog.SetDefault(slog.New(correlatedHandler{Handler: slog.NewJSONHandler(&output, nil)}))
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/schema/{id}", func(w http.ResponseWriter, r *http.Request) {
		if got := baggage.FromContext(r.Context()).Member("test").Value(); got != "propagated" {
			t.Errorf("baggage = %q", got)
		}
		carrier := propagation.MapCarrier{}
		otel.GetTextMapPropagator().Inject(r.Context(), carrier)
		if !strings.HasPrefix(carrier.Get("traceparent"), "00-0123456789abcdef0123456789abcdef-") {
			t.Error("W3C parent was not propagated")
		}
		span := trace.SpanFromContext(r.Context())
		span.SetAttributes(attribute.String("url.full", r.URL.String()), attribute.String("user.email", "private@example.test"))
		span.RecordError(errors.New("private@example.test?token=secret"))
		span.SetStatus(codes.Error, "private@example.test")
		slog.InfoContext(r.Context(), "schema requested", "error", errors.New("private@example.test"), "query", r.URL.RawQuery)
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	request := httptest.NewRequest(http.MethodGet, "/api/v1/schema/private@example.test?token=secret", nil)
	request.Header.Set("Traceparent", "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01")
	request.Header.Set("Baggage", "test=propagated")
	request.Header.Set("Authorization", "secret")
	Middleware(mux).ServeHTTP(httptest.NewRecorder(), request)
	spans := exporter.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("exported %d spans", len(spans))
	}
	encoded, err := json.Marshal(spans)
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{string(encoded), output.String()} {
		for _, secret := range []string{"private@example.test", "token=secret", "Authorization", "url.full"} {
			if strings.Contains(text, secret) {
				t.Errorf("telemetry leaked %q: %s", secret, text)
			}
		}
		if !strings.Contains(text, "GET /api/v1/schema/{id}") {
			t.Errorf("missing route template: %s", text)
		}
	}
	if !strings.Contains(output.String(), `"trace_id":"0123456789abcdef0123456789abcdef"`) || !strings.Contains(output.String(), `"span_id":`) {
		t.Fatalf("missing log correlation: %s", output.String())
	}
	if spans[0].Parent.SpanID().String() != "0123456789abcdef" || spans[0].Status.Code != codes.Error {
		t.Fatalf("parent/status not preserved: %+v", spans[0])
	}
}

func TestExporterOptIn(t *testing.T) {
	for _, key := range []string{"OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_TRACES_EXPORTER", "OTEL_SDK_DISABLED"} {
		t.Setenv(key, "")
	}
	if enabled("TRACES") {
		t.Fatal("local exporter enabled without endpoint")
	}
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://127.0.0.1:4318/v1/traces")
	if !enabled("TRACES") {
		t.Fatal("signal-specific endpoint ignored")
	}
	t.Setenv("OTEL_TRACES_EXPORTER", "none")
	if enabled("TRACES") {
		t.Fatal("explicit disabled exporter ignored")
	}
	t.Setenv("OTEL_TRACES_EXPORTER", "otlp")
	t.Setenv("OTEL_SDK_DISABLED", "true")
	if enabled("TRACES") {
		t.Fatal("disabled SDK ignored")
	}
}

func TestRejectsUnapprovedServiceIdentity(t *testing.T) {
	t.Setenv("OTEL_SERVICE_NAME", "private-sentinel")
	_, err := SetupWithWriter(t.Context(), "synthetic-test", io.Discard)
	if err == nil || strings.Contains(err.Error(), "private-sentinel") {
		t.Fatal("unapproved service identity accepted or exposed")
	}
}

func TestOTLPHTTPExportsCorrelatedLogsAndTraces(t *testing.T) {
	t.Setenv("OTEL_SERVICE_NAME", "manifests-preview")
	type export struct {
		path string
		body []byte
	}
	exports := make(chan export, 10)
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Type") != "application/x-protobuf" {
			t.Error("export did not use protobuf")
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		exports <- export{path: r.URL.Path, body: body}
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	defer collector.Close()
	for _, key := range []string{"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_EXPORTER_OTLP_LOGS_HEADERS", "OTEL_SDK_DISABLED", "OTEL_TRACES_EXPORTER", "OTEL_LOGS_EXPORTER"} {
		t.Setenv(key, "")
	}
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", collector.URL)
	originalLogger, originalProvider, originalPropagator, originalErrorHandler := slog.Default(), otel.GetTracerProvider(), otel.GetTextMapPropagator(), otel.GetErrorHandler()
	t.Cleanup(func() {
		slog.SetDefault(originalLogger)
		otel.SetTracerProvider(originalProvider)
		otel.SetTextMapPropagator(originalPropagator)
		otel.SetErrorHandler(originalErrorHandler)
	})
	var local bytes.Buffer
	shutdown, err := SetupWithWriter(t.Context(), "synthetic-test", &local)
	if err != nil {
		t.Fatal(err)
	}
	ctx, span := otel.Tracer("test").Start(t.Context(), "secret-url?token=private")
	span.SetAttributes(attribute.String("http.route", "GET /api/page"), attribute.String("url.full", "https://private.example?secret=private"))
	span.RecordError(errors.New("private@example.test"))
	slog.InfoContext(ctx, "request completed", "http.route", "GET /api/page", "error", "private@example.test")
	jobCtx, job := otel.Tracer("test").Start(ctx, "schema.download")
	job.SetAttributes(attribute.String("schema.product", "kubernetes"), attribute.String("schema.operation", "download"), attribute.Int("schema.updates", 1), attribute.String("url.full", "https://private.example?secret=private"))
	slog.InfoContext(jobCtx, "schema downloaded", "schema.product", "kubernetes", "schema.operation", "download", "schema.updates", 1, "url.full", "https://private.example?secret=private")
	job.End()
	span.End()
	if err := shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	close(exports)
	if strings.Contains(local.String(), "private") || !strings.Contains(local.String(), `"schema.product":"kubernetes"`) || !strings.Contains(local.String(), `"trace_id":`) {
		t.Fatalf("custom log sink lost sanitized job telemetry: %s", local.String())
	}
	var traceID, logTraceID []byte
	for item := range exports {
		var message proto.Message
		switch item.path {
		case "/v1/traces":
			request := new(tracepb.ExportTraceServiceRequest)
			if err := proto.Unmarshal(item.body, request); err != nil {
				t.Fatal(err)
			}
			for _, resource := range request.ResourceSpans {
				for _, scope := range resource.ScopeSpans {
					for _, exported := range scope.Spans {
						traceID = exported.TraceId
					}
				}
			}
			message = request
		case "/v1/logs":
			request := new(logspb.ExportLogsServiceRequest)
			if err := proto.Unmarshal(item.body, request); err != nil {
				t.Fatal(err)
			}
			for _, resource := range request.ResourceLogs {
				for _, scope := range resource.ScopeLogs {
					for _, record := range scope.LogRecords {
						logTraceID = record.TraceId
					}
				}
			}
			message = request
		default:
			t.Fatalf("unexpected export path %s", item.path)
		}
		encoded := protojson.Format(message)
		if !strings.Contains(encoded, "manifests-preview") {
			t.Fatal("configured service identity missing from export")
		}
		if strings.Contains(encoded, "private") || strings.Contains(encoded, "secret-url") || !strings.Contains(encoded, "GET /api/page") {
			t.Fatalf("unsafe or incomplete export: %s", encoded)
		}
		for _, expected := range []string{"schema.product", "schema.operation", "schema.updates", "kubernetes"} {
			if !strings.Contains(encoded, expected) {
				t.Errorf("job telemetry lost %s in %s", expected, item.path)
			}
		}
	}
	if len(traceID) != 16 || !bytes.Equal(traceID, logTraceID) {
		t.Fatalf("exported trace/log correlation missing: %x / %x", traceID, logTraceID)
	}
}

func TestRenderFailureDiagnosticsSurvivePrivacyFilter(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(privateExporter{SpanExporter: exporter}))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	ctx, span := provider.Tracer("test").Start(t.Context(), "react.render")
	span.SetAttributes(attribute.String("render.failure", "javascript_exception"), attribute.String("error", "private-render-marker"))
	span.RecordError(errors.New("private-render-marker"))
	span.SetStatus(codes.Error, "private-render-marker")
	var output bytes.Buffer
	logger := slog.New(correlatedHandler{Handler: slog.NewJSONHandler(&output, nil)})
	logger.ErrorContext(ctx, "React rendering failed", "render.failure", "javascript_exception", "error", "private-render-marker")
	span.End()
	spans := exporter.GetSpans()
	if len(spans) != 1 || spans[0].Name != "react.render" || spans[0].Status.Code != codes.Error {
		t.Fatalf("render span identity/status lost: %v", spans)
	}
	encoded, err := json.Marshal(spans)
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{string(encoded), output.String()} {
		if !strings.Contains(text, "render.failure") || !strings.Contains(text, "javascript_exception") {
			t.Fatalf("bounded failure category lost: %s", text)
		}
		if strings.Contains(text, "private-render-marker") {
			t.Fatalf("raw exception exposed: %s", text)
		}
	}
	if !strings.Contains(output.String(), span.SpanContext().TraceID().String()) {
		t.Fatal("render log lost trace correlation")
	}
}
