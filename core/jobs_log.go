package core

import (
	"context"
	"log/slog"
	"sync"
	"unicode/utf8"
)

const (
	maxLogLineBytes     = 4096
	maxPersistedLogs    = 10000
	logTruncatedMessage = "… further output truncated …"
)

// truncateLine caps a log line at maxLogLineBytes, cutting on a rune boundary.
func truncateLine(s string) string {
	if len(s) <= maxLogLineBytes {
		return s
	}
	cut := maxLogLineBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

// jobLog buffers one attempt's log lines: batched live events and batched
// persistence, with a per-attempt cap on persisted lines.
type jobLog struct {
	id    string
	store JobStore
	em    Emitter
	clk   clock

	flushMu sync.Mutex // serialises flushes and Logs reads

	mu        sync.Mutex
	seq       int
	persisted int
	capped    bool
	closed    bool
	evBuf     []LogLine
	perBuf    []LogLine
	evTimer   timerHandle
	perTimer  timerHandle
}

func newJobLog(id string, seedSeq int, store JobStore, em Emitter, clk clock) *jobLog {
	return &jobLog{id: id, seq: seedSeq, store: store, em: em, clk: clk}
}

func (l *jobLog) add(stream LogStream, text string) {
	text = truncateLine(text)
	now := NowMillis()
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	mk := func(s LogStream, t string) LogLine {
		l.seq++
		return LogLine{Seq: l.seq, TS: now, Stream: s, Text: t}
	}
	if l.persisted < maxPersistedLogs {
		line := mk(stream, text)
		l.persisted++
		l.perBuf = append(l.perBuf, line)
		l.evBuf = append(l.evBuf, line)
	} else {
		if !l.capped {
			l.capped = true
			marker := mk(StreamSystem, logTruncatedMessage)
			l.perBuf = append(l.perBuf, marker)
			l.evBuf = append(l.evBuf, marker)
		}
		l.evBuf = append(l.evBuf, mk(stream, text))
	}
	if l.evTimer == nil {
		l.evTimer = l.clk.AfterFunc(logEventInterval, func() {
			l.mu.Lock()
			l.evTimer = nil
			l.mu.Unlock()
			l.flushEvents()
		})
	}
	if l.perTimer == nil {
		l.perTimer = l.clk.AfterFunc(logFlushInterval, func() {
			l.mu.Lock()
			l.perTimer = nil
			l.mu.Unlock()
			l.flushPersist()
		})
	}
	l.mu.Unlock()
}

func (l *jobLog) flushEvents() {
	l.flushMu.Lock()
	defer l.flushMu.Unlock()
	l.mu.Lock()
	b := l.evBuf
	l.evBuf = nil
	l.mu.Unlock()
	if len(b) > 0 {
		l.em.Emit(EventJobsLog, JobLogBatch{ID: l.id, Lines: b})
	}
}

func (l *jobLog) flushPersist() {
	l.flushMu.Lock()
	defer l.flushMu.Unlock()
	l.mu.Lock()
	b := l.perBuf
	l.perBuf = nil
	l.mu.Unlock()
	if len(b) == 0 {
		return
	}
	if err := l.store.AppendLogs(context.Background(), l.id, b); err != nil {
		slog.Error("persist job logs", "job", l.id, "err", err)
		l.mu.Lock()
		l.perBuf = append(b, l.perBuf...)
		l.mu.Unlock()
	}
}

// finish stops timers and flushes everything; later adds are ignored.
func (l *jobLog) finish() {
	l.mu.Lock()
	l.closed = true
	if l.evTimer != nil {
		l.evTimer.Stop()
		l.evTimer = nil
	}
	if l.perTimer != nil {
		l.perTimer.Stop()
		l.perTimer = nil
	}
	l.mu.Unlock()
	l.flushEvents()
	l.flushPersist()
}

// all returns persisted lines plus buffered ones.
func (l *jobLog) all() ([]LogLine, error) {
	l.flushMu.Lock()
	defer l.flushMu.Unlock()
	stored, err := l.store.Logs(context.Background(), l.id)
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	out := append(stored[:len(stored):len(stored)], l.perBuf...)
	l.mu.Unlock()
	return out, nil
}
