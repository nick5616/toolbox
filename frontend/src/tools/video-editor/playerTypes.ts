/** What the view needs from either player (sequence or exact preview). */
export interface PlayerHandle {
  play(): void;
  pause(): void;
  toggle(): void;
  /** Seek to a timeline time (ms). */
  seek(ms: number): void;
  playing(): boolean;
}
