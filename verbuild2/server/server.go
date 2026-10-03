package server

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"

	"fmt"
	"image"
	"image/jpeg"
	"io"
	"io/fs"

	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"

	"path/filepath"
	"regexp"

	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"duanjuapp/native/core"

	_ "github.com/nathanstitt/omnidoc/pkg/heif"
)

var (
	editionSlug = "duanjushijie"
	appVersion  = "dev"
)

// 名称由 slug 推导，避免通过 -X 传入中文在 Windows 上被系统编码破坏。
func editionName() string {
	if editionSlug == "quanjushijie" {
		return "全剧视界"
	}
	return "短剧视界"
}

//go:embed web
var webAssets embed.FS

var mediaPort atomic.Value

var localMediaAddress = regexp.MustCompile(`http://(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/`)

// 与 lib/models.dart 的 allValues 保持同一顺序，名称与 Flutter 端一致。
var sourceNames = []struct {
	ID   string
	Name string
}{
	{"hongguo", "红果"},
	{"ikanbot", "爱看机器人"},
	{"hanxiaoquan", "韩小圈"},
	{"guipian", "鬼片"},
	{"sorani", "青空"},
	{"huangdou", "黄豆"},
	{"huangju", "剧果"},
	{"yeguo", "野果"},
	{"dsd", "帝果"},
	{"huangguo-video", "黄果视频"},
	{"huangguoai", "黄果 AI"},
	{"cloudfront", "黄果旧版"},
	{"yaguo", "芽果"},
	{"maoguo", "猫果"},
	{"fanguo", "饭果"},
	{"guanguo", "观果"},
	{"heguo", "河果"},
	{"xingguo", "星果"},
	{"huaguo", "花果"},
	{"niuguo", "牛果"},
	{"wangguo", "网果"},
	{"faguo", "发果"},
	{"piguo", "皮果"},
	{"wuguo", "伍果"},
}

var lastSequence atomic.Int64

func nextSequence() int64 {
	now := time.Now().UnixNano()
	for {
		last := lastSequence.Load()
		next := now
		if next <= last {
			next = last + 1
		}
		if lastSequence.CompareAndSwap(last, next) {
			return next
		}
	}
}

func writeJSON(writer http.ResponseWriter, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		http.Error(writer, "响应编码失败", http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	_, _ = writer.Write(body)
}

func handleRequest(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		http.Error(writer, "只接受 POST 请求", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, 1<<20))
	if err != nil {
		http.Error(writer, "读取请求失败", http.StatusBadRequest)
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	payload := map[string]any{}
	if decoder.Decode(&payload) != nil {
		http.Error(writer, "请求不是合法 JSON", http.StatusBadRequest)
		return
	}
	// 播放解析要求 sequence 严格递增，由服务端统一分配，浏览器不需要关心。
	switch payload["action"] {
	case "resolve", "fallback", "selectRoute":
		payload["sequence"] = json.Number(strconv.FormatInt(nextSequence(), 10))
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		http.Error(writer, "请求编码失败", http.StatusBadRequest)
		return
	}
	reply := rewriteLocalMedia(core.NativeRequest(string(encoded)))
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(writer, reply)
}

// 本机播放服务永远在 127.0.0.1，代理设置只会碍事。
var localTransport = &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 15 * time.Second}).DialContext}

func handleMedia(writer http.ResponseWriter, request *http.Request) {
	port, _ := mediaPort.Load().(string)
	if port == "" {
		http.Error(writer, "还没有正在播放的节目", http.StatusNotFound)
		return
	}
	if request.URL.Path == "/api/media" || request.URL.Path == "/api/media/" {
		http.Error(writer, "媒体地址无效", http.StatusNotFound)
		return
	}
	proxy := &httputil.ReverseProxy{
		Transport: localTransport,
		Director: func(outgoing *http.Request) {
			outgoing.URL.Scheme = "http"
			outgoing.URL.Host = net.JoinHostPort("127.0.0.1", port)
			outgoing.URL.Path = strings.TrimPrefix(outgoing.URL.Path, "/api/media")
			outgoing.Host = outgoing.URL.Host
		},
		ModifyResponse: func(response *http.Response) error {
			if !strings.Contains(response.Header.Get("Content-Type"), "mpegurl") ||
				response.StatusCode != http.StatusOK || response.Body == nil {
				return nil
			}
			body, err := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if err != nil {
				return err
			}
			// 播放列表里的地址指向本机播放服务，局域网设备无法访问，改写成经由本服务转发。
			for _, prefix := range []string{"http://127.0.0.1:" + port + "/", "http://localhost:" + port + "/"} {
				body = []byte(strings.ReplaceAll(string(body), prefix, "/api/media/"))
			}
			response.Body = io.NopCloser(bytes.NewReader(body))
			response.ContentLength = int64(len(body))
			response.Header.Set("Content-Length", strconv.Itoa(len(body)))
			response.Header.Del("Content-Encoding")
			return nil
		},
	}
	proxy.ServeHTTP(writer, request)
}

// rewriteLocalMedia 把核心返回的 127.0.0.1 播放地址改写成经由本服务转发的相对路径，
// 这样本机与局域网设备用的是同一个地址。
func rewriteLocalMedia(reply string) string {
	match := localMediaAddress.FindStringSubmatch(reply)
	if match == nil {
		return reply
	}
	mediaPort.Store(match[1])
	for _, prefix := range []string{
		"http://127.0.0.1:" + match[1] + "/",
		"http://localhost:" + match[1] + "/",
	} {
		reply = strings.ReplaceAll(reply, prefix, "/api/media/")
	}
	return reply
}

type playPlan struct {
	URL           string `json:"url"`
	Quality       int    `json:"quality"`
	Qualities     []int  `json:"qualities"`
	RouteIndex    int    `json:"routeIndex"`
	RouteCount    int    `json:"routeCount"`
	DecryptionKey string `json:"decryptionKey"`
	Session       string `json:"session"`
}

type playReply struct {
	OK    bool     `json:"ok"`
	Error string   `json:"error"`
	Data  playPlan `json:"data"`
}

// pickQuality 默认取 480P：够清晰，转码压力也可控。
func pickQuality(qualities []int, wanted int) int {
	if len(qualities) == 0 {
		return 0
	}
	best := 0
	for _, value := range qualities {
		if value == wanted {
			return value
		}
		if best == 0 {
			best = value
			continue
		}
		if abs(value-wanted) < abs(best-wanted) {
			best = value
		}
	}
	return best
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

// probeCodec 抓一段开头判断编码。多数站源的 moov 在文件头部，足以判定；
// 判断不出来就按可直连处理。
func probeCodec(rawURL string) (encrypted bool, hevc bool) {
	client := &http.Client{Transport: localTransport, Timeout: 20 * time.Second}
	request, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return false, false
	}
	request.Header.Set("Range", "bytes=0-1048575")
	response, err := client.Do(request)
	if err != nil {
		return false, false
	}
	defer response.Body.Close()
	head, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return false, false
	}
	encrypted = bytes.Contains(head, []byte("encv")) || bytes.Contains(head, []byte("enca"))
	hevc = bytes.Contains(head, []byte("hvc1")) ||
		bytes.Contains(head, []byte("hev1")) ||
		bytes.Contains(head, []byte("hvcC"))
	return encrypted, hevc
}

func handlePlay(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		http.Error(writer, "只接受 POST 请求", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, 1<<20))
	if err != nil {
		http.Error(writer, "读取请求失败", http.StatusBadRequest)
		return
	}
	payload := map[string]any{}
	if json.Unmarshal(body, &payload) != nil {
		http.Error(writer, "请求不是合法 JSON", http.StatusBadRequest)
		return
	}
	dramaID, _ := payload["id"].(string)
	if dramaID == "" {
		if nested, ok := payload["drama"].(map[string]any); ok {
			dramaID, _ = nested["id"].(string)
		}
	}
	index := 0
	if value, ok := payload["index"].(float64); ok {
		index = int(value)
	}
	quality := 0
	if value, ok := payload["quality"].(float64); ok {
		quality = int(value)
	}
	route := 0
	if value, ok := payload["route"].(float64); ok {
		route = int(value)
	}
	force, _ := payload["force"].(bool)
	if quality <= 0 {
		quality = 480
	}
	if route < 0 {
		route = 0
	}

	// 先按默认画质探一次，拿到可选画质后再挑目标画质重新解析。
	probe := map[string]any{}
	for key, value := range payload {
		if key == "quality" || key == "route" || key == "force" || key == "action" {
			continue
		}
		probe[key] = value
	}
	probe["action"] = "resolve"
	probe["route"] = route
	probe["sequence"] = json.Number(strconv.FormatInt(nextSequence(), 10))
	encoded, err := json.Marshal(probe)
	if err != nil {
		http.Error(writer, "请求编码失败", http.StatusBadRequest)
		return
	}
	first := playReply{}
	if err := json.Unmarshal([]byte(core.NativeRequest(string(encoded))), &first); err != nil || !first.OK {
		message := first.Error
		if message == "" {
			message = "解析播放地址失败"
		}
		writeJSON(writer, map[string]any{"ok": false, "error": message})
		return
	}
	wanted := pickQuality(first.Data.Qualities, quality)
	if wanted != 0 && wanted != first.Data.Quality {
		probe["quality"] = wanted
		probe["sequence"] = json.Number(strconv.FormatInt(nextSequence(), 10))
		if encoded, err = json.Marshal(probe); err == nil {
			var second playReply
			if json.Unmarshal([]byte(core.NativeRequest(string(encoded))), &second) == nil && second.OK {
				first = second
			}
		}
	}

	plan := first.Data
	rawURL := plan.URL
	mediaURL := rewriteLocalMedia(rawURL)
	encryptedKey := plan.DecryptionKey
	detectedEncrypted, hevc := probeCodec(rawURL)
	encrypted := encryptedKey != "" || detectedEncrypted

	answer := map[string]any{
		"url":        mediaURL,
		"quality":    plan.Quality,
		"qualities":  plan.Qualities,
		"routeIndex": plan.RouteIndex,
		"routeCount": plan.RouteCount,
		"encrypted":  encrypted,
		"hevc":       hevc,
		"ffmpeg":     ffmpegPath() != "",
		"mode":       "direct",
	}
	binary := ffmpegPath()
	if binary != "" && (encrypted || hevc || force) {
		key := jobKey(dramaID, strconv.Itoa(index), strconv.Itoa(wanted), strconv.Itoa(route), encryptedKey)
		job, err := transcoder.start(key, rawURL, encryptedKey)
		if err == nil {
			ready, failure := transcoder.wait(job)
			if ready {
				answer["mode"] = "hls"
				answer["url"] = "/api/live/" + key + "/index.m3u8"
				answer["transcoding"] = !job.isFinished()
			} else if failure != "" {
				answer["message"] = "转码失败：" + failure
			} else {
				// ffmpeg 还在准备第一个分片，让播放器自己重试。
				answer["mode"] = "hls"
				answer["url"] = "/api/live/" + key + "/index.m3u8"
				answer["transcoding"] = true
			}
		} else {
			answer["message"] = err.Error()
		}
	} else if binary == "" && (encrypted || hevc) {
		answer["message"] = "需要 ffmpeg 转码"
	}
	writeJSON(writer, map[string]any{"ok": true, "data": answer})
}

func handleLive(writer http.ResponseWriter, request *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/live/"), "/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		http.NotFound(writer, request)
		return
	}
	job := transcoder.get(parts[0])
	if job == nil {
		http.NotFound(writer, request)
		return
	}
	target := filepath.Clean(filepath.Join(job.dir, filepath.FromSlash(parts[1])))
	if target != job.dir && !strings.HasPrefix(target, job.dir+string(filepath.Separator)) {
		http.NotFound(writer, request)
		return
	}
	// 明确给出类型，免得依赖系统 mime 表（.ts 在部分系统上会被识别错）。
	switch strings.ToLower(filepath.Ext(target)) {
	case ".m3u8":
		writer.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	case ".ts", ".m4s":
		writer.Header().Set("Content-Type", "video/mp2t")
	case ".mp4":
		writer.Header().Set("Content-Type", "video/mp4")
	}
	writer.Header().Set("Cache-Control", "no-store")
	http.ServeFile(writer, request, target)
}

// 封面转换串行执行：单张转换只需几十毫秒，串行足以撑住本地页面的并发。
var coverConvert sync.Mutex

// convertHEIC 把核心缓存的 HEIC 封面转码为浏览器可显示的 JPEG，
// 结果与 Flutter 端 CoverDecoder 一样缓存在 covers 目录的 compatible-v1 下。
func convertHEIC(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("封面缓存文件不存在")
	}
	base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	directory := filepath.Join(filepath.Dir(path), "compatible-v1")
	target := filepath.Join(directory, fmt.Sprintf("%s-%d-%d.jpg", base, info.ModTime().UnixNano(), info.Size()))
	if stat, err := os.Stat(target); err == nil && stat.Mode().IsRegular() && stat.Size() > 4 {
		return target, nil
	}
	coverConvert.Lock()
	defer coverConvert.Unlock()
	if stat, err := os.Stat(target); err == nil && stat.Mode().IsRegular() && stat.Size() > 4 {
		return target, nil
	}
	source, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer source.Close()
	// 解码器遇到异常数据可能 panic，兜底成普通错误让页面回退到占位图。
	defer func() {
		if recover() != nil {
			err = errors.New("封面解码失败")
		}
	}()
	decoded, _, err := image.Decode(source)
	if err != nil {
		return "", err
	}
	buffered := new(bytes.Buffer)
	if err := jpeg.Encode(buffered, decoded, &jpeg.Options{Quality: 82}); err != nil {
		return "", err
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return "", err
	}
	part := target + ".part"
	if err := os.WriteFile(part, buffered.Bytes(), 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(part, target); err != nil {
		_ = os.Remove(part)
		return "", err
	}
	return target, nil
}

func handleCover(writer http.ResponseWriter, request *http.Request) {
	id := strings.TrimSpace(request.URL.Query().Get("id"))
	if id == "" {
		http.Error(writer, "缺少剧集 id", http.StatusBadRequest)
		return
	}
	drama := map[string]any{"id": id}
	if source := strings.TrimSpace(request.URL.Query().Get("source")); source != "" {
		drama["source"] = source
	}
	if cover := strings.TrimSpace(request.URL.Query().Get("u")); cover != "" {
		parsed, err := url.Parse(cover)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			http.Error(writer, "封面地址无效", http.StatusBadRequest)
			return
		}
		drama["cover"] = cover
	}
	encoded, err := json.Marshal(map[string]any{"action": "cover", "drama": drama})
	if err != nil {
		http.Error(writer, "请求编码失败", http.StatusInternalServerError)
		return
	}
	reply := struct {
		OK   bool `json:"ok"`
		Data struct {
			Path string `json:"path"`
			HEIC bool   `json:"heic"`
		} `json:"data"`
		Error string `json:"error"`
	}{}
	if err := json.Unmarshal([]byte(core.NativeRequest(string(encoded))), &reply); err != nil || !reply.OK || reply.Data.Path == "" {
		http.Error(writer, "封面暂不可用", http.StatusNotFound)
		return
	}
	path := reply.Data.Path
	if reply.Data.HEIC {
		converted, err := convertHEIC(path)
		if err == nil {
			path = converted
		}
	}
	file, err := os.Open(path)
	if err != nil {
		http.Error(writer, "封面暂不可用", http.StatusNotFound)
		return
	}
	defer file.Close()
	head := make([]byte, 512)
	count, _ := io.ReadFull(file, head)
	contentType := "application/octet-stream"
	if count > 0 {
		if detected := http.DetectContentType(head[:count]); detected != "" {
			contentType = detected
		}
	}
	writer.Header().Set("Content-Type", contentType)
	writer.Header().Set("Cache-Control", "public, max-age=86400")
	if _, err := file.Seek(0, io.SeekStart); err == nil {
		_, _ = io.Copy(writer, file)
	} else {
		_, _ = writer.Write(head[:count])
	}
}

func handleSources(writer http.ResponseWriter, request *http.Request) {
	items := []map[string]string{}
	for _, source := range sourceNames {
		encoded, err := json.Marshal(map[string]any{"action": "sourceStatus", "source": source.ID})
		if err != nil {
			continue
		}
		answer := struct {
			OK bool `json:"ok"`
		}{}
		if json.Unmarshal([]byte(core.NativeRequest(string(encoded))), &answer) == nil && answer.OK {
			items = append(items, map[string]string{"id": source.ID, "name": source.Name})
		}
	}
	writeJSON(writer, map[string]any{"items": items})
}

// NewHandler 构造 HTTP 处理器，供 Vercel Serverless Function 入口复用。
// 数据目录 / 本地核心初始化只在首次调用时执行一次。
func NewHandler() (http.Handler, error) {
	if v := os.Getenv("EDITION_SLUG"); v != "" {
		editionSlug = v
	}
	if v := os.Getenv("APP_VERSION"); v != "" {
		appVersion = v
	}
	directory := os.Getenv("DATA_DIR")
	if directory == "" {
		directory = filepath.Join(os.TempDir(), editionSlug+"-data")
	}
	// 核心要求数据目录是绝对路径，DATA_DIR 传相对路径时先归一化。
	if !filepath.IsAbs(directory) {
		if absolute, err := filepath.Abs(directory); err == nil {
			directory = absolute
		}
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return nil, err
	}
	// 播放记录与收藏跟着数据目录走，删掉数据目录即可一并清空。
	setLibraryDirectory(directory)
	encoded, err := json.Marshal(map[string]any{"action": "initialize", "directory": directory})
	if err != nil {
		return nil, err
	}
	answer := struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}{}
	if err := json.Unmarshal([]byte(core.NativeRequest(string(encoded))), &answer); err != nil || !answer.OK {
		if answer.Error != "" {
			return nil, errors.New(answer.Error)
		}
		if err != nil {
			return nil, err
		}
		return nil, errors.New("本地核心初始化失败")
	}

	site, err := fs.Sub(webAssets, "web")
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, "/web/", http.StatusFound)
	})
	mux.Handle("/web/", http.StripPrefix("/web/", http.FileServer(http.FS(site))))
	mux.HandleFunc("/api/request", handleRequest)
	mux.HandleFunc("/api/play", handlePlay)
	mux.HandleFunc("/api/media/", handleMedia)
	mux.HandleFunc("/api/live/", handleLive)
	mux.HandleFunc("/api/cover", handleCover)
	mux.HandleFunc("/api/sources", handleSources)
	mux.HandleFunc("/api/library", handleLibrary)
	mux.HandleFunc("/api/info", func(writer http.ResponseWriter, request *http.Request) {
		writeJSON(writer, map[string]any{
			"name":    editionName(),
			"slug":    editionSlug,
			"version": appVersion,
			"ffmpeg":  ffmpegPath(),
			"vercel":  true,
		})
	})
	return mux, nil
}

var (
	handlerOnce sync.Once
	handler     http.Handler
	handlerErr  error
)

// Handler 返回单例 HTTP 处理器，确保核心只初始化一次。
func Handler() (http.Handler, error) {
	handlerOnce.Do(func() {
		handler, handlerErr = NewHandler()
	})
	return handler, handlerErr
}
