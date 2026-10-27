package proc

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
)

// Process is a long-running child with piped stdin (e.g. the Python
// sidecar). Output is delivered line by line through Spec.OnStdout and
// Spec.OnStderr exactly as with Run. Cancelling the Start ctx, or calling
// Kill, kills the whole process tree.
type Process struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *lineWriter
	stderr *lineWriter
	tail   *tailBuffer
	ctx    context.Context

	waitOnce sync.Once
	res      Result
	err      error
	done     chan struct{}
}

// Start launches s with a stdin pipe and returns immediately.
func Start(ctx context.Context, s Spec) (*Process, error) {
	cmd := exec.CommandContext(ctx, s.Path, s.Args...)
	cmd.Dir = s.Dir
	cmd.Env = append(os.Environ(), s.Env...)
	configure(cmd)
	cmd.Cancel = func() error { return killTree(cmd) }
	cmd.WaitDelay = waitDelay

	p := &Process{cmd: cmd, tail: &tailBuffer{max: StderrTailLines}, ctx: ctx, done: make(chan struct{})}
	p.stdout = newLineWriter(s.OnStdout)
	p.stderr = newLineWriter(func(line string) {
		p.tail.add(line)
		if s.OnStderr != nil {
			s.OnStderr(line)
		}
	})
	cmd.Stdout = p.stdout
	cmd.Stderr = p.stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe for %s: %w", s.Path, err)
	}
	p.stdin = stdin
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", s.Path, err)
	}
	go p.wait()
	return p, nil
}

func (p *Process) wait() {
	err := p.cmd.Wait()
	p.stdout.Flush()
	p.stderr.Flush()
	res := Result{ExitCode: -1, StderrTail: p.tail.lines()}
	if p.cmd.ProcessState != nil {
		res.ExitCode = p.cmd.ProcessState.ExitCode()
	}
	if ctxErr := p.ctx.Err(); ctxErr != nil {
		err = fmt.Errorf("run %s: %w", p.cmd.Path, ctxErr)
	} else if err != nil {
		err = fmt.Errorf("run %s: %w", p.cmd.Path, err)
	}
	p.res, p.err = res, err
	close(p.done)
}

// Stdin is the child's standard input. Callers must serialise writes.
func (p *Process) Stdin() io.Writer { return p.stdin }

// CloseStdin closes the child's standard input (signals EOF).
func (p *Process) CloseStdin() error { return p.stdin.Close() }

// Done is closed when the process has exited and output is flushed.
func (p *Process) Done() <-chan struct{} { return p.done }

// Wait blocks until the process exits and returns its result.
func (p *Process) Wait() (Result, error) {
	<-p.done
	return p.res, p.err
}

// Kill force-kills the process tree. It is safe to call more than once.
func (p *Process) Kill() error {
	select {
	case <-p.done:
		return nil
	default:
	}
	return killTree(p.cmd)
}

// Pid is the child's process ID.
func (p *Process) Pid() int {
	if p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}
