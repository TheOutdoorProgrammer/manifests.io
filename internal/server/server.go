package server

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/TheOutdoorProgrammer/manifests.io/internal/schema"
)

type Config struct {
	WebDir       string
	RenderDir    string
	PublicDir    string
	SiteURL      string
	RendererFile string
}

type Catalog interface {
	Page(schema.Query) (schema.Page, error)
	Products() []schema.Product
	Definitions(schema.Query) ([]schema.Definition, error)
	Routes() []schema.Query
}

type Server struct {
	catalog  Catalog
	config   Config
	shell    []byte
	renderer *reactRenderer
	crawlers map[string]crawlerFile
}

func New(catalog Catalog, config Config) (*Server, error) {
	shell, err := os.ReadFile(filepath.Join(config.WebDir, "index.html"))
	if err != nil {
		return nil, fmt.Errorf("read frontend build: %w", err)
	}
	for _, marker := range []string{"<!--app-html-->", "<!--page-data-->", "<!--page-head-->"} {
		if !bytes.Contains(shell, []byte(marker)) {
			return nil, fmt.Errorf("frontend template is missing %s", marker)
		}
	}
	if config.SiteURL == "" {
		config.SiteURL = "https://www.manifests.io"
	}
	site, err := url.Parse(config.SiteURL)
	if err != nil || site.Host == "" || (site.Scheme != "https" && site.Scheme != "http") || site.User != nil || site.RawQuery != "" || site.Fragment != "" || (site.Path != "" && site.Path != "/") {
		return nil, errors.New("SITE_URL must be an HTTP(S) origin")
	}
	config.SiteURL = strings.TrimRight(config.SiteURL, "/")
	crawlers, err := buildCrawlerFiles(config.SiteURL, catalog.Routes())
	if err != nil {
		return nil, fmt.Errorf("build crawler documents: %w", err)
	}
	if config.RendererFile == "" {
		config.RendererFile = filepath.Join(config.WebDir, "..", "dist-render", "renderer.js")
	}
	renderer, err := newReactRenderer(config.RendererFile)
	if err != nil {
		return nil, err
	}
	return &Server{catalog: catalog, config: config, shell: shell, renderer: renderer, crawlers: crawlers}, nil
}

func RenderFilename(canonical string) string {
	digest := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(digest[:]) + ".html.gz"
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://rum.stout.zone https://faro-collector-prod-us-east-3.grafana.net https://g.theoutdoorprogrammer.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if len(r.URL.RequestURI()) > 8192 {
		http.Error(w, "URL is too long", http.StatusRequestURITooLong)
		return
	}
	switch r.URL.Path {
	case "/healthz", "/readyz":
		r.Pattern = r.URL.Path
		writeJSON(w, r, http.StatusOK, map[string]string{"status": "ok"})
		return
	case "/":
		r.Pattern = "/"
		query := schema.DefaultQuery(s.catalog.Products())
		if query.Version == "" {
			s.failure(w, r, http.StatusServiceUnavailable, "No Kubernetes documentation is available.", false)
			return
		}
		cachePublic(w)
		http.Redirect(w, r, schema.Href(query), http.StatusTemporaryRedirect)
		return
	case "/api/catalog":
		r.Pattern = "/api/catalog"
		writeJSON(w, r, http.StatusOK, s.catalog.Products())
		return
	case "/api/definitions":
		r.Pattern = "/api/definitions"
	case "/robots.txt", "/sitemap.xml":
		r.Pattern = r.URL.Path
		s.serveCrawler(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/sitemap-") && strings.HasSuffix(r.URL.Path, ".xml") {
		r.Pattern = "/sitemap-{chunk}.xml"
		s.serveCrawler(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/assets/") {
		r.Pattern = "/assets/{file}"
		if strings.HasSuffix(r.URL.Path, ".map") {
			http.NotFound(w, r)
			return
		}
		s.serveFile(w, r, s.config.WebDir, true)
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") && strings.Count(r.URL.Path, "/") == 1 && strings.Contains(filepath.Base(r.URL.Path), ".") {
		r.Pattern = "/{asset}"
		s.serveFile(w, r, s.config.PublicDir, false)
		return
	}
	query, err := parseQuery(r)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, schema.ErrNotFound) {
			status = http.StatusNotFound
		}
		s.failure(w, r, status, "This documentation URL is invalid.", false)
		return
	}
	query.Path, query.Trail = "", ""
	if r.URL.Path == "/api/definitions" {
		definitions, err := s.catalog.Definitions(query)
		if err != nil {
			s.schemaFailure(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, definitions)
		return
	}
	if r.URL.Path == "/api/page" {
		r.Pattern = "/api/page"
	} else if query.Resource != "" {
		r.Pattern = "/{item}/{version}/{resource}"
	} else {
		r.Pattern = "/{item}/{version}"
	}
	page, err := s.catalog.Page(query)
	if err != nil {
		s.schemaFailure(w, r, err)
		return
	}
	if r.URL.Path == "/api/page" {
		writeJSON(w, r, http.StatusOK, page)
		return
	}
	s.servePage(w, r, http.StatusOK, page, true)
}

func parseQuery(r *http.Request) (schema.Query, error) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return schema.Query{}, err
	}
	for key, values := range values {
		if len(values) != 1 {
			return schema.Query{}, fmt.Errorf("duplicate parameter %s", key)
		}
	}
	q := schema.Query{Path: values.Get("path"), Pointer: values.Get("pointer"), Trail: values.Get("trail"), OneOf: values.Get("oneOf"), Key: values.Get("key")}
	if q.Path == "" {
		q.Path = values.Get("linked")
	}
	if r.URL.Path == "/api/page" || r.URL.Path == "/api/definitions" {
		q.Item, q.Version, q.Resource = values.Get("item"), values.Get("version"), values.Get("resource")
	} else {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
		if len(parts) < 2 || len(parts) > 3 || strings.HasPrefix(r.URL.Path, "/api/") {
			return q, schema.ErrNotFound
		}
		q.Item, q.Version = parts[0], parts[1]
		if len(parts) == 3 {
			q.Resource = parts[2]
		}
	}
	if q.Item == "" || q.Version == "" || strings.ContainsAny(q.Item+q.Version+q.Resource, "/\\\x00") {
		return q, schema.ErrBadQuery
	}
	return q, nil
}

func (s *Server) serveFile(w http.ResponseWriter, r *http.Request, root string, immutable bool) {
	rel := strings.TrimPrefix(r.URL.Path, "/")
	if !fs.ValidPath(rel) || strings.Contains(rel, "\\") {
		http.NotFound(w, r)
		return
	}
	file := filepath.Join(root, filepath.FromSlash(rel))
	info, err := os.Stat(file)
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	if immutable {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		cachePublic(w)
	}
	http.ServeFile(w, r, file)
}

func (s *Server) schemaFailure(w http.ResponseWriter, r *http.Request, err error) {
	status, message := http.StatusInternalServerError, "The documentation could not be loaded."
	if errors.Is(err, schema.ErrNotFound) {
		status, message = http.StatusNotFound, "This resource or version was not found."
	} else if errors.Is(err, schema.ErrBadQuery) {
		status, message = http.StatusBadRequest, "This documentation URL is invalid."
	}
	s.failure(w, r, status, message, errors.Is(err, schema.ErrNotFound))
}

func (s *Server) failure(w http.ResponseWriter, r *http.Request, status int, message string, cacheable bool) {
	query, err := parseQuery(r)
	if err != nil {
		query = schema.Query{}
	}
	page := failurePage(s.catalog, query, message)
	if strings.HasPrefix(r.URL.Path, "/api/") {
		if cacheable {
			cachePublic(w)
		}
		writeJSON(w, r, status, page)
		return
	}
	s.servePage(w, r, status, page, cacheable)
}

func failurePage(catalog Catalog, query schema.Query, message string) schema.Page {
	products := catalog.Products()
	defaultQuery := schema.DefaultQuery(products)
	page := schema.Page{Item: defaultQuery.Item, Version: defaultQuery.Version, Title: "Documentation unavailable", Error: message, Catalog: products, Canonical: "/"}
	if query.Item != "" && query.Version != "" {
		if _, err := catalog.Page(schema.Query{Item: query.Item, Version: query.Version}); err == nil {
			page.Item, page.Version = query.Item, query.Version
			page.Resource = query.Resource
		}
	}
	return page
}

func (s *Server) servePage(w http.ResponseWriter, r *http.Request, status int, page schema.Page, cacheable bool) {
	body := s.shell
	prerendered := false
	if status == http.StatusOK && page.Path == "" && page.Trail == "" {
		if rendered, err := readRendered(filepath.Join(s.config.RenderDir, RenderFilename(page.Canonical))); err == nil {
			body = rendered
			prerendered = true
		}
	}
	data, err := json.Marshal(page)
	if err != nil {
		http.Error(w, "Could not render documentation", http.StatusInternalServerError)
		return
	}
	if !prerendered {
		rendered, err := s.renderer.render(r.Context(), data)
		if err != nil {
			slog.ErrorContext(r.Context(), "React rendering failed", "render.failure", renderFailureKind(err))
			http.Error(w, "Could not render documentation", http.StatusServiceUnavailable)
			return
		}
		body = bytes.ReplaceAll(body, []byte("<!--app-html-->"), rendered)
	}
	body = bytes.ReplaceAll(body, []byte("<!--page-data-->"), append(append([]byte(`<script id="__PAGE_DATA__" type="application/json">`), data...), []byte("</script>")...))
	body = bytes.ReplaceAll(body, []byte("<!--page-head-->"), []byte(pageHead(page, s.config.SiteURL, status)))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if cacheable {
		cachePublic(w)
	}
	digest := sha256.Sum256(body)
	etag := `"` + hex.EncodeToString(digest[:]) + `"`
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag && status == http.StatusOK {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

func pageHead(page schema.Page, site string, status int) string {
	canonical := site + page.Canonical
	title := html.EscapeString(page.Title + " | Manifests.io")
	description := page.Description
	if description == "" {
		description = "Browse Kubernetes and custom resource fields, types, and versions."
	}
	if len(description) > 320 {
		description = string([]rune(description)[:min(160, len([]rune(description)))])
	}
	head := `<title>` + title + `</title><meta name="description" content="` + html.EscapeString(description) + `"><link rel="canonical" href="` + html.EscapeString(canonical) + `"><meta property="og:title" content="` + title + `"><meta property="og:description" content="` + html.EscapeString(description) + `"><meta property="og:url" content="` + html.EscapeString(canonical) + `"><meta property="og:image" content="` + site + `/ogimage.png">`
	head += `<meta property="og:site_name" content="Manifests.io"><meta property="og:image:alt" content="Manifests.io"><meta property="og:image:width" content="887"><meta property="og:image:height" content="465"><meta property="og:image:type" content="image/png">`
	if status != http.StatusOK {
		head += `<meta name="robots" content="noindex">`
	}
	return head
}

func readRendered(filename string) ([]byte, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	reader, err := gzip.NewReader(file)
	if err != nil {
		return nil, err
	}
	defer func() { _ = reader.Close() }()
	const maxPage = 16 << 20
	body, err := io.ReadAll(io.LimitReader(reader, maxPage+1))
	if len(body) > maxPage {
		return nil, errors.New("prerendered page exceeds size limit")
	}
	return body, err
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if status == http.StatusOK && strings.HasPrefix(r.URL.Path, "/api/") {
		cachePublic(w)
	}
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_ = json.NewEncoder(w).Encode(value)
	}
}

func cachePublic(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "public, max-age=0, s-maxage=604800, must-revalidate")
}
