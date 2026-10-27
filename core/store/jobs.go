package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"toolbox/core"
)

const jobCols = `id, module_id, title, status, progress, message, inputs, options,
	error_code, error, error_hint, attempt, created_at, started_at, finished_at`

func encodeInputs(in []string) (string, error) {
	if in == nil {
		in = []string{}
	}
	b, err := json.Marshal(in)
	if err != nil {
		return "", fmt.Errorf("encode job inputs: %w", err)
	}
	return string(b), nil
}

func optionsOrEmpty(s string) string {
	if strings.TrimSpace(s) == "" {
		return "{}"
	}
	return s
}

func (d *DB) InsertJob(ctx context.Context, j core.Job) error {
	inputs, err := encodeInputs(j.Inputs)
	if err != nil {
		return err
	}
	_, err = d.sql.ExecContext(ctx, `INSERT INTO jobs (`+jobCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		j.ID, j.ModuleID, j.Title, string(j.Status), j.Progress, j.Message, inputs, optionsOrEmpty(j.OptionsJSON),
		string(j.ErrorCode), j.Error, j.ErrorHint, j.Attempt, j.CreatedAt, j.StartedAt, j.FinishedAt)
	if err != nil {
		return fmt.Errorf("insert job %s: %w", j.ID, err)
	}
	return nil
}

func (d *DB) UpdateJob(ctx context.Context, j core.Job) error {
	inputs, err := encodeInputs(j.Inputs)
	if err != nil {
		return err
	}
	res, err := d.sql.ExecContext(ctx, `UPDATE jobs SET module_id=?, title=?, status=?, progress=?, message=?,
		inputs=?, options=?, error_code=?, error=?, error_hint=?, attempt=?, created_at=?, started_at=?, finished_at=?
		WHERE id=?`,
		j.ModuleID, j.Title, string(j.Status), j.Progress, j.Message, inputs, optionsOrEmpty(j.OptionsJSON),
		string(j.ErrorCode), j.Error, j.ErrorHint, j.Attempt, j.CreatedAt, j.StartedAt, j.FinishedAt, j.ID)
	if err != nil {
		return fmt.Errorf("update job %s: %w", j.ID, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return core.Errorf(core.CodeNotFound, "Job not found")
	}
	return nil
}

func (d *DB) GetJob(ctx context.Context, id string) (core.Job, error) {
	jobs, err := d.queryJobs(ctx, `SELECT `+jobCols+` FROM jobs WHERE id = ?`, id)
	if err != nil {
		return core.Job{}, err
	}
	if len(jobs) == 0 {
		return core.Job{}, core.Errorf(core.CodeNotFound, "Job not found")
	}
	return jobs[0], nil
}

func (d *DB) ListJobs(ctx context.Context, f core.JobFilter) ([]core.Job, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	var where []string
	var args []any
	if f.ModuleID != "" {
		where = append(where, "module_id = ?")
		args = append(args, f.ModuleID)
	}
	if len(f.Statuses) > 0 {
		ph := make([]string, len(f.Statuses))
		for i, s := range f.Statuses {
			ph[i] = "?"
			args = append(args, string(s))
		}
		where = append(where, "status IN ("+strings.Join(ph, ",")+")")
	}
	q := `SELECT ` + jobCols + ` FROM jobs`
	if len(where) > 0 {
		q += ` WHERE ` + strings.Join(where, " AND ")
	}
	q += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit)
	return d.queryJobs(ctx, q, args...)
}

// queryJobs runs a job SELECT and populates Outputs for all results.
func (d *DB) queryJobs(ctx context.Context, q string, args ...any) ([]core.Job, error) {
	rows, err := d.sql.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query jobs: %w", err)
	}
	jobs := []core.Job{}
	for rows.Next() {
		var j core.Job
		var status, errCode, inputs string
		if err := rows.Scan(&j.ID, &j.ModuleID, &j.Title, &status, &j.Progress, &j.Message, &inputs, &j.OptionsJSON,
			&errCode, &j.Error, &j.ErrorHint, &j.Attempt, &j.CreatedAt, &j.StartedAt, &j.FinishedAt); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan job: %w", err)
		}
		j.Status = core.JobStatus(status)
		j.ErrorCode = core.ErrorCode(errCode)
		if err := json.Unmarshal([]byte(inputs), &j.Inputs); err != nil {
			rows.Close()
			return nil, fmt.Errorf("decode inputs of job %s: %w", j.ID, err)
		}
		if j.Inputs == nil {
			j.Inputs = []string{}
		}
		j.Outputs = []core.Output{}
		jobs = append(jobs, j)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, fmt.Errorf("query jobs: %w", err)
	}
	if len(jobs) == 0 {
		return jobs, nil
	}
	ids := make([]any, len(jobs))
	ph := make([]string, len(jobs))
	idx := make(map[string]int, len(jobs))
	for i, j := range jobs {
		ids[i] = j.ID
		ph[i] = "?"
		idx[j.ID] = i
	}
	outs, err := d.queryOutputs(ctx, `SELECT `+outputCols+` FROM outputs WHERE job_id IN (`+strings.Join(ph, ",")+`)
		ORDER BY created_at, id`, ids...)
	if err != nil {
		return nil, err
	}
	for _, o := range outs {
		i := idx[o.JobID]
		jobs[i].Outputs = append(jobs[i].Outputs, o)
	}
	return jobs, nil
}

func (d *DB) DeleteJobs(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("delete jobs: %w", err)
	}
	defer tx.Rollback()
	for _, id := range ids {
		if _, err := tx.ExecContext(ctx, `DELETE FROM jobs WHERE id = ?`, id); err != nil {
			return fmt.Errorf("delete job %s: %w", id, err)
		}
	}
	return tx.Commit()
}

func (d *DB) AppendLogs(ctx context.Context, jobID string, lines []core.LogLine) error {
	if len(lines) == 0 {
		return nil
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("append logs: %w", err)
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO job_logs (job_id, seq, ts, stream, line) VALUES (?,?,?,?,?)`)
	if err != nil {
		return fmt.Errorf("append logs: %w", err)
	}
	defer stmt.Close()
	for _, l := range lines {
		if _, err := stmt.ExecContext(ctx, jobID, l.Seq, l.TS, string(l.Stream), l.Text); err != nil {
			return fmt.Errorf("append log %d of job %s: %w", l.Seq, jobID, err)
		}
	}
	return tx.Commit()
}

func (d *DB) Logs(ctx context.Context, jobID string) ([]core.LogLine, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT seq, ts, stream, line FROM job_logs WHERE job_id = ? ORDER BY seq`, jobID)
	if err != nil {
		return nil, fmt.Errorf("query logs: %w", err)
	}
	defer rows.Close()
	out := []core.LogLine{}
	for rows.Next() {
		var l core.LogLine
		var stream string
		if err := rows.Scan(&l.Seq, &l.TS, &stream, &l.Text); err != nil {
			return nil, fmt.Errorf("scan log: %w", err)
		}
		l.Stream = core.LogStream(stream)
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("query logs: %w", err)
	}
	return out, nil
}

func (d *DB) CountLogs(ctx context.Context, jobID string) (int, error) {
	var n int
	err := d.sql.QueryRowContext(ctx, `SELECT count(*) FROM job_logs WHERE job_id = ?`, jobID).Scan(&n)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("count logs: %w", err)
	}
	return n, nil
}
