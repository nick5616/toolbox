package tts

import (
	"context"
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Service is Text to Speech's typed Wails service.
type Service struct {
	jobs *core.Jobs
	m    *Module
}

// NewService builds the service.
func NewService(jobs *core.Jobs, m *Module) *Service { return &Service{jobs: jobs, m: m} }

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// Voices lists the voices the picker offers.
func (s *Service) Voices() []VoiceInfo { return Voices() }

// Enqueue queues one job per text file.
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	opts.Preview = false
	return s.submit(paths, opts)
}

// SpeakText reads typed or pasted text: it is saved as a .txt file (named
// after its first words) and queued like any other input.
func (s *Service) SpeakText(text string, opts Options) ([]core.Job, error) {
	path, err := s.m.writeText(text)
	if err != nil {
		return nil, err
	}
	opts.Preview = false
	return s.submit([]string{path}, opts)
}

// Preview queues a quick job that speaks one sample sentence in opts.Voice
// at opts.Speed. Its result's previewPath is a wav in the preview cache; it
// registers no library output.
func (s *Service) Preview(opts Options) ([]core.Job, error) {
	voice, ok := lookupVoice(opts.Voice)
	if !ok {
		return nil, core.ValidationError("Choose a voice from the list", map[string]string{"voice": "Choose a voice from the list"})
	}
	path, err := s.m.writeText(voice.Sample)
	if err != nil {
		return nil, err
	}
	opts.Preview, opts.Split = true, SplitNone
	return s.submit([]string{path}, opts)
}

// DiscardPreviews deletes all preview audio (the view calls it on unmount).
func (s *Service) DiscardPreviews() { s.m.DiscardPreviews() }

func (s *Service) submit(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal text to speech options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}

// ResultShape exists so the binding generator emits Result and FileResult;
// it returns the zero value.
func (s *Service) ResultShape() Result { return Result{} }

// StepShape returns the pipeline step options (bindings only).
func (s *Service) StepShape() StepOptions { return DefaultStepOptions() }
