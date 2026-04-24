// Match phase state machine.
//
// LOBBY -> SUBMIT -> VOTE -> RESULTS
//                              |
//                              └-> REMATCH (creates new match)
// any phase can -> CANCELLED (host or admin)
//
// NOTE: 'reveal' was removed from the lifecycle. The listen/review time
// is absorbed into the vote phase. Any in-flight match at status='reveal'
// is flushed forward to 'vote' on the next tick (one-shot migration path
// in tick.ts).

export type Phase = 'lobby' | 'submit' | 'vote' | 'results';

export type PhaseDurations = {
  submitSeconds: number;
  // revealSeconds is no longer used in timing calculations.
  // The field still exists in GenreFormatConfig for historical data
  // compatibility but has no effect on match flow.
  voteSeconds: number;
};

export function nextPhase(current: Phase | 'reveal'): Phase | null {
  switch (current) {
    case 'lobby':
      return 'submit';
    case 'submit':
      return 'vote';
    // In-flight migration: any match stuck at 'reveal' advances to 'vote'.
    case 'reveal':
      return 'vote';
    case 'vote':
      return 'results';
    case 'results':
      return null;
  }
}
