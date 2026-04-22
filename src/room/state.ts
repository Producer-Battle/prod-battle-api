// Match phase state machine.
//
// LOBBY  → SUBMIT  → REVEAL → VOTE → RESULTS
//                                      │
//                                      └─> REMATCH (creates new match)
// any phase can → CANCELLED (host or admin)

export type Phase = 'lobby' | 'submit' | 'reveal' | 'vote' | 'results';

export type PhaseDurations = {
  submitSeconds: number;
  revealSeconds: number;
  voteSeconds: number;
};

export function nextPhase(current: Phase): Phase | null {
  switch (current) {
    case 'lobby':
      return 'submit';
    case 'submit':
      return 'reveal';
    case 'reveal':
      return 'vote';
    case 'vote':
      return 'results';
    case 'results':
      return null;
  }
}
