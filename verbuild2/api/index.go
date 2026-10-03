// Vercel Go Serverless Function 入口。注意：包名不叫 main（与 Vercel 官方示例一致），
// 这样既能本地 go build 通过，也能被 Vercel 正确编译为函数。
package handler

import (
	"net/http"

	"duanjuapp/native/server"
)

// Handler 是 Vercel Go Serverless Function 的入口函数。
// Vercel 会把每一个 HTTP 请求交给本函数，再由 server.Handler() 复用同一个 HTTP 处理器，
// 其中包含静态网页（/web/）与全部 /api/* 接口。
func Handler(w http.ResponseWriter, r *http.Request) {
	h, err := server.Handler()
	if err != nil {
		http.Error(w, "服务初始化失败："+err.Error(), http.StatusInternalServerError)
		return
	}
	h.ServeHTTP(w, r)
}
