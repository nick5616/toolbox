/**
 * Catches a render error in part of the UI so the rest keeps working. The
 * fallback says what broke and offers Try again (remounts the children).
 * `resetKey` remounts automatically when it changes (e.g. another tool view).
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import styles from "./ErrorBoundary.module.css";

export interface ErrorBoundaryProps {
  /** What the area is, for the message ("This panel", "Edit Studio"). */
  label: string;
  children: ReactNode;
  /** Remount when this changes. */
  resetKey?: string;
  /** Small inline fallback (panels) instead of a full-page one (views). */
  compact?: boolean;
}

interface State {
  error: Error | null;
  key: string | undefined;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.label} failed:`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const retry = (
      <Button size="sm" icon="rotate-ccw" data-tip="Load this part of the app again; if it keeps failing, restart Toolbox" onClick={() => this.setState({ error: null })}>
        Try again
      </Button>
    );
    if (this.props.compact) {
      return (
        <div role="alert" className={styles.compact}>
          <span>{`${this.props.label} hit a problem: ${error.message}`}</span>
          {retry}
        </div>
      );
    }
    return <EmptyState icon="triangle-alert" size="lg" title={`${this.props.label} hit a problem`} body={error.message} action={retry} />;
  }
}
