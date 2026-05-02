// Match phase state machine.
//
// LOBBY -> SUBMIT (produce in DAW) -> UPLOAD (2 min hard upload window) -> VOTE -> RESULTS
//                                                                                    |
//                                                                                    └-> REMATCH (creates new match)
// any phase can -> CANCELLED (host or admin)
//
// NOTE: 'reveal' was removed from the lifecycle. The listen/review time
// is absorbed into the vote phase. Any in-flight match at status='reveal'
// is flushed forward to 'vote' on the next tick (one-shot migration path
// in tick.ts).
//
// 'submit' is now the production phase. When it expires, the match enters
// 'upload' for a fixed 2-minute window where producers must finalize and
// upload (or forfeit). If everyone has uploaded mid-submit, the match
// short-circuits straight to 'vote' (no need to wait out the upload buffer).

export type Phase = 'lobby' | 'submit' | 'upload' | 'vote' | 'results';

export type PhaseDurations = {
  submitSeconds: number;
  // revealSeconds is no longer used in timing calculations.
  // The field still exists in GenreFormatConfig for historical data
  // compatibility but has no effect on match flow.
  voteSeconds: number;
};

// 2 minutes hard upload window after the produce phase. Hardcoded across
// every game mode per the alpha UX spec - if it ever needs to vary by mode
// or genre, lift to game_rules.
export const UPLOAD_PHASE_SECONDS = 120;

export function nextPhase(current: Phase | 'reveal'): Phase | null {
  switch (current) {
    case 'lobby':
      return 'submit';
    case 'submit':
      return 'upload';
    case 'upload':
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
