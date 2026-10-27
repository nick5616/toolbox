package core

import (
	"errors"
	"fmt"
)

// ErrorCode classifies an AppError. It crosses the Wails boundary as JSON and
// is what the frontend switches on.
type ErrorCode string

const (
	CodeValidation        ErrorCode = "validation"
	CodeDependencyMissing ErrorCode = "dependency_missing"
	CodeNotFound          ErrorCode = "not_found"
	CodeConflict          ErrorCode = "conflict"
	CodeToolFailed        ErrorCode = "tool_failed"
	CodeCancelled         ErrorCode = "cancelled"
	CodeInterrupted       ErrorCode = "interrupted"
	CodeNotImplemented    ErrorCode = "not_implemented"
	CodeInternal          ErrorCode = "internal"
)

// AppError is the single structured error type surfaced to users.
// Message and Hint are user-facing: sentence case, no trailing period.
type AppError struct {
	Code    ErrorCode         `json:"code"`
	Message string            `json:"message"`
	Hint    string            `json:"hint,omitempty"`
	Fields  map[string]string `json:"fields,omitempty"`
	Err     error             `json:"-"`
}

func (e *AppError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Err)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *AppError) Unwrap() error { return e.Err }

// WithHint returns e with Hint set (for fluent construction).
func (e *AppError) WithHint(hint string) *AppError {
	e.Hint = hint
	return e
}

// WithCause returns e with Err set (for fluent construction).
func (e *AppError) WithCause(err error) *AppError {
	e.Err = err
	return e
}

// Errorf builds an AppError with a formatted user-facing message.
func Errorf(code ErrorCode, format string, args ...any) *AppError {
	return &AppError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// ValidationError builds a CodeValidation error with per-field messages.
func ValidationError(message string, fields map[string]string) *AppError {
	return &AppError{Code: CodeValidation, Message: message, Fields: fields}
}

// ErrDependencyMissing reports that an external tool could not be resolved.
func ErrDependencyMissing(depID, hint string) *AppError {
	return &AppError{
		Code:    CodeDependencyMissing,
		Message: fmt.Sprintf("%s isn't installed", depID),
		Hint:    hint,
	}
}

// NotImplemented is returned by contract stubs until their work package lands.
func NotImplemented(what string) *AppError {
	return Errorf(CodeNotImplemented, "%s isn't implemented yet", what)
}

// AsAppError returns err as an *AppError, wrapping unknown errors as
// CodeInternal while keeping the cause for logs. nil stays nil.
func AsAppError(err error) *AppError {
	if err == nil {
		return nil
	}
	var ae *AppError
	if errors.As(err, &ae) {
		return ae
	}
	return &AppError{Code: CodeInternal, Message: "Something went wrong", Err: err}
}

// IsCode reports whether err is an AppError with the given code.
func IsCode(err error, code ErrorCode) bool {
	var ae *AppError
	return errors.As(err, &ae) && ae.Code == code
}
