//go:build !windows

package server

import "os/exec"

func attachProcess(command *exec.Cmd) {}
